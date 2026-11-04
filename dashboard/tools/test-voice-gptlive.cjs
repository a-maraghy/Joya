#!/usr/bin/env node
"use strict";
/**
 * The live call on GPT-Live (lib/voice-gptlive.js) against a mock of OpenAI's
 * {ws}/live/sessions that speaks the event shapes measured on the real API
 * on 2026-10-29 (session.started, session.input_transcript.delta and
 * session.output_transcript.delta with start_ms / end_ms, a continuous
 * session.output_audio.delta stream, session.delegation.created with
 * metadata only, the appends' acknowledgements, session.usage.updated in
 * seconds, session.closed), with a fake page, a fake supervisor, a fake
 * reader and a fake transcriber. No network beyond 127.0.0.1.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-voice-gptlive.cjs
 */
const path = require("path");
const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const live = require(path.join(ROOT, "lib", "voice-live.js"));
const sg = require(path.join(ROOT, "lib", "voice-speechgate.js"));
const gl = require(path.join(ROOT, "lib", "voice-gptlive.js"));
const voice = require(path.join(ROOT, "lib", "voice.js"));
const desk = require(path.join(ROOT, "lib", "voice-shared.js"));
const usage = require(path.join(ROOT, "lib", "voice-usage.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

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
async function until(fn, ms, label) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(5);
  }
  if (label) console.log("       (timed out waiting for " + label + ")");
  return false;
}

/* --------------------------------------------------------- mock GPT-Live --- */

const KEY = "sk-proj-" + "G".repeat(40) + "live";
const mock = { sessions: [] };
const mockServer = http.createServer((q, s) => (s.writeHead(404), s.end()));
const mockWss = new WebSocketServer({ noServer: true });
mockServer.on("upgrade", (req, sock, head) => {
  if (String(req.headers.authorization || "") !== "Bearer " + KEY) {
    sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return sock.destroy();
  }
  // The real endpoint answers 403 to a browser Origin.
  if (req.headers.origin) {
    sock.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return sock.destroy();
  }
  mockWss.handleUpgrade(req, sock, head, (ws) => {
    const s = { url: req.url, ws, events: [], session: null, appended: 0, closed: false, silentBytes: 0 };
    s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
    s.of = (type) => s.events.filter((e) => e.type === type);
    ws.on("close", () => (s.closed = true));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "session.input_audio.append") {
        const b = Buffer.from(ev.audio, "base64");
        s.appended += b.length;
        if (b.every((x) => x === 0)) s.silentBytes += b.length;
        return;
      }
      s.events.push(ev);
      if (ev.type === "session.start") {
        s.session = ev.session;
        s.push({ type: "session.started", session: { id: "live_test", ...ev.session } });
      }
      if (/^session\.(commentary|thinking|instructions)\.append$/.test(ev.type)) {
        setTimeout(() => s.push({ type: ev.type.replace(/append$/, "appended"), client_event_id: ev.event_id, start_ms: 0, end_ms: 200 }), s.ackMs || 5);
      }
      if (ev.type === "session.close") s.push({ type: "session.closed", client_event_id: ev.event_id, usage: { seconds: (s.secs || 0) + 3 } });
    });
    mock.sessions.push(s);
  });
});
const lastSession = () => mock.sessions[mock.sessions.length - 1];

function tone(ms, amp) {
  const b = Buffer.alloc(Math.round(ms * 48));
  const a = amp == null ? 6000 : amp;
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 8 < 4 ? a : -a, i);
  return b;
}

/** GPT-Live saying `say`: each word's transcript, then ~100 ms of loud audio (its transcript leads by a little). */
async function speak(s, say, o) {
  const opt = o || {};
  const words = say.match(/\S+\s*/g) || [];
  let tl = opt.tl || 5000;
  for (let i = 0; i < words.length; i++) {
    s.push({ type: "session.output_transcript.delta", delta: (i ? "" : " ") + words[i], start_ms: tl, end_ms: tl + 200 });
    await sleep(opt.gap || 15);
    s.push({ type: "session.output_audio.delta", delta: tone(100).toString("base64") });
    tl += 200;
    if (opt.stopAfter && i + 1 >= opt.stopAfter) return;
  }
  // then silence, as the real stream goes on
  for (let i = 0; i < (opt.tail == null ? 2 : opt.tail); i++) {
    s.push({ type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") });
    await sleep(10);
  }
}
/** The administrator's words, as GPT-Live transcribes them. */
async function hear(s, c, text, o) {
  const opt = o || {};
  c.audioIn(tone(opt.ms || 1500, 3000));
  let tl = opt.tl == null ? 1000 : opt.tl;
  for (const w of text.split(" ")) {
    s.push({ type: "session.input_transcript.delta", delta: " " + w, start_ms: tl, end_ms: tl + 200 });
    tl += 200;
    await sleep(opt.gap || 2);
  }
  return tl;
}

/* ------------------------------------------------------------ the fakes --- */

function makeCall(extra) {
  const x = extra || {};
  const client = { json: [], audio: [], closed: null };
  const sup = { calls: [], replies: new Map(), nextTurn: 700 };
  const call = (op, params, actor) => {
    sup.calls.push([op, params, actor]);
    if (op === "snapshot") {
      const snap = { machine: {}, services: {} };
      if (params && params.turns) snap.requests_to_joya_ai = params.turns.map((id) => ({ id, answered: sup.replies.has(id), reply: sup.replies.get(id) }));
      return Promise.resolve(snap);
    }
    if (op === "send") return Promise.resolve({ turn: { id: ++sup.nextTurn, status: "queued" } });
    if (op === "voice-warm") return Promise.resolve({ warmed: true, lanes: [] });
    return Promise.reject(new Error("refused " + op));
  };
  const spoke = [];
  const rows = [];
  const transcribed = [];
  const logs = [];
  const c = new gl.GptLiveCall({
    cfg: { key: KEY, voice: "cedar", model: "gpt-realtime-2.1-mini", live_model: "gpt-live-1", transcribe_model: "gpt-4o-mini-transcribe", wsBase: WS_BASE, ...(x.cfg || {}) },
    actor: "amaraghy",
    ops: desk.voiceOps(call, "amaraghy"),
    client: {
      json: (o) => client.json.push(o),
      audio: (seg, buf) => client.audio.push({ seg, bytes: buf.length, at: Date.now() }),
      close: (code, why) => (client.closed = { code, why }),
    },
    persona: () => x.persona || {},
    hearPersona: () => x.persona || {},
    speak: async (text, cfg, sink) => {
      spoke.push(text);
      sink.start({ engine: "fake" });
      sink.audio(tone(200));
      return { billing: [{ model: "gpt-realtime-2.1-mini", tokens: { text_in: 20, audio_out: 40 } }], lateBilling: Promise.resolve([]) };
    },
    transcribe: async (wav) => {
      transcribed.push(wav.length);
      return { text: x.turnText == null ? "" : x.turnText, model: "gpt-4o-mini-transcribe", tokens: { audio_in: 30, text_in: 5, text_out: 10 } };
    },
    ...(x.summarise ? { summarise: x.summarise } : {}),
    record: (row) => {
      const r = { ...row, usd: usage.costOf(row.tokens, row.model) };
      rows.push(r);
      return r.usd;
    },
    isStop: (t) => VoiceStop.heard(t),
    isUndo: (t) => VoiceStop.undo(t),
    log: (m) => logs.push(m),
    redact: (t) => t,
    voiceprint: x.voiceprint || null,
    opts: { pollMs: 20, duplex: x.duplex || "full", holdMs: x.holdMs == null ? 60 : x.holdMs, ...(x.opts || {}) },
  });
  return { c, client, sup, spoke, rows, transcribed, logs };
}
const sentOf = (s, type) => s.events.filter((e) => e.type === type);

let WS_BASE;

(async () => {
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + mockServer.address().port + "/v1";

  section("the model list and the price");
  {
    const m = voice.VOICE_MODELS.find((v) => v.id === "gpt-live-1");
    check("gpt-live-1 is offered as a voice model (gated on the key's model list), never the default", m && m.gated === true && voice.VOICE_MODEL_DEFAULT === "gpt-realtime-2.1-mini");
    check("its replies are never read aloud by it (the reader stays 2.1 mini)", voice.readerModelFor("gpt-live-1") === "gpt-realtime-2.1-mini");
    check("it speaks the live protocol", voice.protocolFor("gpt-live-1") === "live" && voice.protocolFor("gpt-realtime-2.1-mini") === "realtime");
    check("priced by session time: $0.05 a minute (60 s -> $0.05)", Math.abs(usage.costOf({ seconds: 60 }, "gpt-live-1") - 0.05) < 1e-9);
    const access = voice.modelAccess(["gpt-live-1", "gpt-realtime-2.1-mini"]);
    check("offered when the key lists it, not when it does not", access["gpt-live-1"].available && !voice.modelAccess(["gpt-realtime-2.1-mini"])["gpt-live-1"].available);
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check("server.js starts a GptLiveCall when the voice model speaks the live protocol", /voice\.protocolFor\(cfg\.live_model\) === "live" \? voiceGptLive\.GptLiveCall : voiceLive\.LiveCall/.test(src));
  }

  section("the session: client delegation, the voice, no Origin header");
  {
    const { c, client, logs } = makeCall({ persona: { dialect: "egyptian", gender: "f" } });
    await c.connect();
    const s = lastSession();
    check("connects to {ws}/live/sessions (the mock refuses any Origin header with 403)", /\/v1\/live\/sessions$/.test(s.url), s.url);
    const cfg = s.session;
    check("session.start: model gpt-live-1, client delegation", cfg.model === "gpt-live-1" && cfg.delegation && cfg.delegation.type === "client");
    check("PCM 24 kHz, the panel's voice (cedar)", cfg.audio.format.type === "audio/pcm" && cfg.audio.format.rate === 24000 && cfg.audio.output.voice === "cedar");
    check("the prompt asks for delegation with <|SpawnThinking|> and has the three policies", /<\|SpawnThinking\|>/.test(cfg.instructions) && /Backchannel policy/.test(cfg.instructions) && /Interruption policy/.test(cfg.instructions) && /Delegation policy/.test(cfg.instructions));
    check("the persona's language line is in it", /Egyptian/i.test(cfg.instructions));
    check("state listening once started", client.json.some((m) => m.type === "state" && m.state === "listening"));
    // Realtime events the base class may send never reach GPT-Live.
    c.send({ type: "response.cancel" });
    c.send({ type: "conversation.item.truncate", item_id: "x", content_index: 0, audio_end_ms: 0 });
    c.send({ type: "input_audio_buffer.clear" });
    c.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(System note: the line dropped.)" }] } });
    await sleep(40);
    check("realtime-only events are dropped; a conversation note becomes session.thinking.append", !s.events.some((e) => /^(response|conversation|input_audio_buffer)\./.test(e.type)) && sentOf(s, "session.thinking.append").some((e) => /line dropped/.test(e.content) && e.delegation_id === null));
    // The clock: the page sends nothing, the session still hears (silence).
    const before = s.appended;
    await sleep(450);
    check("with no microphone audio the server keeps GPT-Live's timeline fed with silence", s.appended - before >= 48 * 200 && s.silentBytes >= 48 * 200, s.appended - before);
    c.audioIn(tone(100, 3000));
    await sleep(20);
    check("the microphone's audio is relayed as session.input_audio.append", s.appended > before);
    s.push({ type: "session.usage.updated", usage: { seconds: 12 }, context_window: { usage_ratio: 0.01 } });
    s.push({ type: "session.usage.updated", usage: { seconds: 30 }, context_window: { usage_ratio: 0.02 } });
    s.secs = 30; // the mock's session.closed reports the cumulative total + 3
    await sleep(30);
    c.close("hung-up");
    await sleep(60);
    check("session.close is sent when the call ends", sentOf(s, "session.close").length === 1);
    check("usage: the session's seconds are billed once each (12 + 18 + the closing 3 = 33 s)", Math.abs(c.liveSecs - 33) < 1e-9 && Math.abs(c.usd - (33 / 60) * 0.05) < 1e-9, c.liveSecs + " s, $" + c.usd);
    void logs;
  }

  section("small talk: GPT-Live answers itself, its words are guarded before they are heard");
  {
    const { c, client } = makeCall();
    await c.connect();
    const s = lastSession();
    await hear(s, c, "hey how are you");
    await speak(s, "I'm good, thanks. How are you?");
    await until(() => client.json.some((m) => m.type === "segend"), 2000, "segend");
    check("its audio reaches the page (held a moment for its words)", client.audio.length >= 6);
    check("its words are captioned", client.json.some((m) => m.type === "caption" && m.who === "desk" && /good/.test(m.text)));
    await until(() => client.json.some((m) => m.type === "caption" && m.who === "you"), 2500, "the turn's caption");
    check("the administrator's turn is captioned from GPT-Live's transcript", client.json.some((m) => m.type === "caption" && m.who === "you" && /how are you/.test(m.text)));
    check("no hand-off for small talk", !c.requests.size);
    c.close("hung-up");
  }

  section("a claim GPT-Live cannot back is cut before it is heard");
  {
    const { c, client, spoke } = makeCall();
    await c.connect();
    const s = lastSession();
    await hear(s, c, "restart the odoo service");
    await speak(s, "Sure, I restarted the Odoo service and it is running again.");
    await until(() => c.diag.gptlive.cuts > 0, 2000, "the cut");
    check("the guard cuts the utterance", c.diag.gptlive.cuts === 1 && c.diag.trips[0] && /claim/.test(c.diag.trips[0].rule), JSON.stringify(c.diag.trips));
    const heard = client.audio.length;
    check("none of it reached the page (cut while its audio was still held)", heard === 0, heard + " chunks");
    check("GPT-Live is told to stop (session.instructions.append)", sentOf(s, "session.instructions.append").some((e) => /Stop speaking/.test(e.content)));
    await until(() => spoke.length > 0, 3000, "the safe line");
    check("the safe line is read by the verbatim reader", spoke.length >= 1);
    c.close("hung-up");
  }

  section("a delegation: GPT-Live's own transcript goes to JOYA AI (no transcription model), the result goes back as commentary");
  {
    // turnText: what a transcription model would have written -- never asked for on GPT-Live (2026-10-30).
    const { c, client, sup, transcribed, rows } = makeCall({ turnText: "Can you check why the dashboard restarted last night?" });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "can you check why the dashboard restarted last nite");
    s.push({ type: "session.delegation.created", offset_ms: end + 300, delegation: { id: "item_deleg1", type: "delegation", target: "client" } });
    await speak(s, "On it.");
    await until(() => sup.calls.some((x) => x[0] === "send"), 4000, "the hand-off");
    const sent = sup.calls.find((x) => x[0] === "send");
    check("no transcription model is called on a GPT-Live call", transcribed.length === 0, transcribed.length);
    check("  and no transcription is billed", !rows.some((r) => r.part === "transcription"), JSON.stringify(rows.map((r) => r.part)));
    check("JOYA AI gets GPT-Live's own transcript as the request ('nite' and all)", sent && /^can you check why the dashboard restarted last nite$/.test(sent[1].text), sent && sent[1].text);
    check("  with no note about another transcript", sent && !/transcript|\[Voice:/.test(sent[1].text), sent && sent[1].text);
    check("the ack 'On it.' passes (a delegation backs it)", client.json.some((m) => m.type === "caption" && /On it/.test(m.text)) && !client.json.some((m) => m.type === "cut"));
    const id = [...c.requests.keys()][0];
    sup.replies.set(id, "The dashboard restarted at 02:14 because a deploy ran. It has been up since and nothing is wrong.");
    await until(() => sentOf(s, "session.commentary.append").length > 0, 3000, "the commentary");
    const com = sentOf(s, "session.commentary.append")[0];
    check("the result goes to GPT-Live as commentary on the same delegation", com && com.delegation_id === "item_deleg1" && /02:14/.test(com.content) && /nothing is wrong/.test(com.content), JSON.stringify(com));
    // GPT-Live says it in its own words, faithfully: heard.
    await speak(s, "Looks like the dashboard restarted at 02:14 because a deploy ran. It's been up since, and nothing is wrong.");
    await until(() => client.json.filter((m) => m.type === "caption" && m.who === "joya").length >= 2, 3000, "the result captions");
    check("a faithful paraphrase is heard and captioned as JOYA AI's", client.json.filter((m) => m.type === "caption" && m.who === "joya").length >= 2 && !client.json.some((m) => m.type === "cut"));
    check("state: waiting while JOYA AI works (or speaking/listening after)", client.json.some((m) => m.type === "state" && m.state === "waiting"));
    c.close("hung-up");
  }

  section("\"I'll check that right now\" with a delegation behind it is not a promise; one hand-off per turn");
  {
    const { c, client, sup } = makeCall({ turnText: "قوليلي فاضل قد ايه مساحة على الديسك" });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "قوليلي فاضل قد ايه مساحة على الديسك");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg5", type: "delegation", target: "client" } });
    await speak(s, "حاضر، هشوف المساحة حالا.");
    await until(() => sup.calls.some((x) => x[0] === "send"), 4000, "the hand-off");
    await sleep(1900);
    check("«هشوف ... حالا» after a delegation: not cut", c.diag.gptlive.cuts === 0 && !client.json.some((m) => m.type === "cut"), JSON.stringify(c.diag.trips));
    check("  and captioned as said", client.json.some((m) => m.type === "caption" && /حالا/.test(m.text || "")));
    check("exactly one hand-off for the turn", sup.calls.filter((x) => x[0] === "send").length === 1);
    c.close("hung-up");
  }

  section("a result said wrongly is cut and said again, correctly, by GPT-Live itself (the same voice)");
  {
    const { c, client, sup, spoke } = makeCall({ turnText: "How much disk space is free?" });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "how much disk space is free");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg2", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    const id = [...c.requests.keys()][0];
    sup.replies.set(id, "There are 41 GB free on the main disk, out of 200 GB.");
    await until(() => sentOf(s, "session.commentary.append").length > 0, 3000, "the commentary");
    await speak(s, "You've got about 14 GB free on the main disk.", { gap: 25 });
    await until(() => c.diag.gptlive.cuts > 0, 2000, "the cut");
    check("a wrong figure in a result is cut (before it is heard)", c.diag.gptlive.cuts === 1 && /figure/.test(c.diag.trips[0].rule), JSON.stringify(c.diag.trips));
    await until(() => sentOf(s, "session.commentary.append").filter((e) => /41 GB/.test(e.content)).length >= 2, 4000, "the correction");
    check("the correct sentence goes back to GPT-Live as a new commentary", sentOf(s, "session.commentary.append").filter((e) => /There are 41 GB free on the main disk, out of 200 GB\./.test(e.content)).length === 2);
    check("  not to the reader (another voice)", !spoke.some((t) => /41 GB/.test(t)), spoke.join(" | "));
    check("  GPT-Live is told to say only that part, as a correction (quiet context)", sentOf(s, "session.thinking.append").some((e) => /Do not repeat anything you already said.*corrects/.test(e.content)));
    c.close("hung-up");
  }

  // Call lv1g84s, 2026-10-30 ("I asked the weather, it was said twice"): the summary of the weather, GPT-Live
  // saying it in its own words -- sentences joined -- and "tomorrow it should be overcast" (a forecast) cut as
  // added advice; the reader then counted GPT-Live's sentences into the summary's and read the weather again.
  const WEATHER_REPLY = "It's mainly clear in 6th of October City right now, about 25 degrees, feeling like 23, with light wind and no rain expected today or tomorrow. Tonight should drop to around 14 degrees, and tomorrow will be overcast with a high of 25.";
  const WEATHER_SUMMARY = [
    "Sure.",
    "It's mainly clear in 6th of October City right now, about 25 degrees.",
    "It feels like 23, with light wind and no rain expected today or tomorrow.",
    "Tonight it will drop to around 14 degrees, and tomorrow will be overcast with a high of 25.",
    "Let me know if you need anything else.",
  ];
  async function weatherCall(say) {
    const summarise = async (id, o) => {
      for (const t of WEATHER_SUMMARY) o.onLine({ text: t, safe: false });
      return { tokens: { text_in: 300, text_out: 60 } };
    };
    const k = makeCall({ summarise });
    const { c, sup } = k;
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "can you tell me what's the weather like");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_wx", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    sup.replies.set([...c.requests.keys()][0], WEATHER_REPLY);
    await until(() => sentOf(s, "session.commentary.append").length >= 4, 3000, "the summary");
    await speak(s, say, { gap: 8, tail: 6 });
    await sleep(QUIET_WAIT);
    return { ...k, s };
  }
  const QUIET_WAIT = 1400;

  section("2026-10-30 (call lv1g84s): the weather said with \"should\" for \"will\" -- a forecast restating the result, not advice: not cut");
  {
    const { c, spoke, logs } = await weatherCall("Sure. It's mainly clear in 6th of October City right now, about 25 degrees, feeling like 23, with light wind and no rain expected today or tomorrow. Tonight it should drop to around 14 degrees, and tomorrow it should be overcast with a high of 25.");
    check("not cut", c.diag.gptlive.cuts === 0, JSON.stringify(c.diag.trips));
    check("  the reader reads nothing (the weather is said once)", spoke.length === 0, JSON.stringify(spoke));
    check("  logged: how many sentences the live voice said of the result, none cut", logs.some((l) => /the live voice said 3 sentences of the result \(utterance 1 of it, 3 passed\): "Sure\./.test(l)), JSON.stringify(logs.slice(-4)));
    c.close("hung-up");
  }

  section("2026-10-30 (call lv1g84s): a cut after GPT-Live joined the result's sentences -> the reader reads only what was not heard, matched by content");
  {
    const { c, spoke, logs } = await weatherCall("Sure, it's mainly clear in 6th of October City right now, about 25 degrees, feeling like 23, with light wind and no rain expected today or tomorrow. Tonight it'll drop to around 14 degrees, and you should take an umbrella tomorrow.");
    const s2 = lastSession();
    await until(() => sentOf(s2, "session.commentary.append").some((e) => e.content === WEATHER_SUMMARY[3]), 4000, "the continuation");
    check("real added advice is still cut", c.diag.gptlive.cuts === 1 && c.diag.trips[0].rule === "added-recommendation", JSON.stringify(c.diag.trips));
    check("  GPT-Live is given the one sentence not yet heard, never the weather already said", sentOf(s2, "session.commentary.append").filter((e) => e.content === WEATHER_SUMMARY[3]).length === 1 && spoke.length === 0, JSON.stringify(spoke));
    check("  (counting would have re-read it all: the sentence before the cut was heard but not yet released -- 0 passed)", c.diag.trips[0].released === 0, JSON.stringify(c.diag.trips));
    check("  logged: what the reader read, by index", logs.some((l) => /after the cut the live voice is given 1 of the result's 5 sentences \[3\] \(heard \[0,1,2\], nothing to add \[0,4\]; the live voice had said 2, 0 passed, cut at 1, added-recommendation\)/.test(l)), JSON.stringify(logs.filter((l) => /after the cut/.test(l))));
    c.close("hung-up");
  }

  section("a cut when everything of the result was already heard -> the reader reads nothing");
  {
    const { c, spoke, logs } = await weatherCall("Sure. It's mainly clear in 6th of October City right now, about 25 degrees, feeling like 23, with light wind and no rain expected today or tomorrow. Tonight it'll drop to around 14 degrees, and tomorrow will be overcast with a high of 25. You should stay inside tomorrow.");
    await sleep(800);
    check("cut on the added advice", c.diag.gptlive.cuts === 1 && c.diag.trips[0].rule === "added-recommendation", JSON.stringify(c.diag.trips));
    check("  nothing is read again", spoke.length === 0, JSON.stringify(spoke));
    check("  logged as 0 read", logs.some((l) => /after the cut the live voice is given 0 of the result's 5 sentences/.test(l)), JSON.stringify(logs.filter((l) => /after the cut/.test(l))));
    c.close("hung-up");
  }

  // Call lv1m3r7, 2026-10-30 ("it says the reply, then in another voice afterwards it is said again"): GPT-Live
  // said all three sentences of the result, one word changed («مش بقدر» for «مش هقدر»), and its last clause was
  // cut (an Arabic clause the parser cannot read). Everything was heard: nothing is said again, by anyone.
  section("2026-10-30 (call lv1m3r7): a cut on the last sentence of a result fully said -> nothing is said again, no second voice");
  {
    const REPLY = "مش هقدر أتأكد من الصوت نفسه. أنا بعرف مين بيتكلم من الاسم اللي النظام بيبعته معاي في المكالمة، فلو حد غيرك اتكلم والنظام ما عرفوش، مش هعرف أفرّق بينكم بالصوت. لو حصل وأنا مش متأكد، هفترض إن ده مش انت ومش هتصرف بصلاحياتك.";
    const { c, sup, spoke, logs } = makeCall({ turnText: "هل تقدر تعرف صوتي؟" });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "هل تقدر تعرف صوتي لو حد تاني اتكلم");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_vp", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    sup.replies.set([...c.requests.keys()][0], REPLY);
    await until(() => sentOf(s, "session.commentary.append").length > 0, 3000, "the result");
    const before = sentOf(s, "session.commentary.append").length;
    await speak(s, "مش بقدر أتأكد من الصوت نفسه. أنا بعرف مين بيتكلم من الاسم اللي النظام بيبعته معاي في المكالمة، فلو حد غيرك اتكلم والنظام ما عرفوش، مش هعرف أفرّق بينكم بالصوت. ساعتها هفترض إن ده مش إنت، ومش هتصرف بصلاحياتك.", { gap: 8, tail: 6 });
    await sleep(QUIET_WAIT + 600);
    const cut = c.diag.gptlive.cuts;
    check("(the last clause may be cut)", cut <= 1, JSON.stringify(c.diag.trips));
    check("  the reader says nothing (no second voice)", spoke.length === 0, JSON.stringify(spoke));
    check("  GPT-Live is given nothing more", sentOf(s, "session.commentary.append").length === before, JSON.stringify(sentOf(s, "session.commentary.append").slice(before)));
    if (cut) check("  logged: 0 given, all three heard", logs.some((l) => /after the cut the live voice is given 0 of the result's 3 sentences \[\] \(heard \[0,1,2\]/.test(l)), JSON.stringify(logs.filter((l) => /after the cut/.test(l))));
    c.close("hung-up");
  }

  section("barge-in: the page's detector stops the voice at once, GPT-Live is muted until quiet");
  {
    const { c, client } = makeCall();
    await c.connect();
    const s = lastSession();
    await hear(s, c, "tell me something");
    const p = speak(s, "Here is a long sentence that goes on and on while the administrator wants to say something else entirely.", { gap: 30 });
    await until(() => client.audio.length >= 3, 2000, "audio");
    c.message({ type: "voice", on: true });
    check("a flush goes to the page at once", client.json.some((m) => m.type === "flush"));
    const n = client.audio.length;
    await p;
    await sleep(100);
    check("nothing more of that utterance reaches the page", client.audio.length === n, client.audio.length - n);
    // GPT-Live goes quiet (silence frames), then speaks again: heard.
    for (let i = 0; i < 5; i++) s.push({ type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") }), await sleep(80);
    await speak(s, "Sure, go ahead.");
    await until(() => client.audio.length > n, 2000, "audio after the barge-in");
    check("once it has been quiet, its next words are heard again", client.audio.length > n);
    check("the barge-in is in the diagnostics", c.diag.bargeIns.length === 1 && c.diag.gptlive.bargeStops.length === 1);
    c.close("hung-up");
  }

  section("headphones: the administrator's voice over the voice, heard in the relayed microphone, is a barge-in");
  {
    const { c, client } = makeCall();
    await c.connect();
    const s = lastSession();
    for (let i = 0; i < 10; i++) c.audioIn(tone(20, 30)); // a quiet room
    await hear(s, c, "tell me a story", { ms: 20 });
    const p = speak(s, "Once upon a time there was a server that never slept and always answered.", { gap: 30 });
    await until(() => client.audio.length >= 2, 2000, "audio");
    check("no flush from a quiet room while it speaks", !client.json.some((m) => m.type === "flush"));
    for (let i = 0; i < 4; i++) c.audioIn(tone(100, 4000));
    check("300 ms of the administrator's voice over it: flushed", client.json.some((m) => m.type === "flush") && c.diag.gptlive.bargeStops.some((b) => b.how === "mic"));
    await p;
    c.close("hung-up");
  }

  section("speakers mode: GPT-Live hears silence while it is audible; a tap interrupts");
  {
    const { c, client } = makeCall({ duplex: "speakers" });
    await c.connect();
    const s = lastSession();
    await hear(s, c, "hello there");
    const p = speak(s, "Hello! It is good to hear from you today, how can I help?", { gap: 30 });
    await until(() => client.audio.length >= 2, 2000, "audio");
    const silentBefore = s.silentBytes;
    c.audioIn(tone(100, 5000));
    await sleep(20);
    check("the microphone is replaced by silence while the voice is audible", s.silentBytes - silentBefore >= 4800, s.silentBytes - silentBefore);
    c.message({ type: "interrupt" });
    check("a tap flushes the page", client.json.some((m) => m.type === "flush"));
    await sleep(20);
    check("and tells GPT-Live to stop and listen", sentOf(s, "session.instructions.append").some((e) => /interrupted/.test(e.content)));
    await p;
    c.close("hung-up");
  }

  section("language: a switch is told to GPT-Live quietly");
  {
    const { c } = makeCall();
    await c.connect();
    const s = lastSession();
    await hear(s, c, "how much disk is free");
    await sleep(1700);
    await hear(s, c, "قوليلي فاضل قد ايه مساحة", { tl: 6000 });
    await sleep(60);
    check("after English, three Arabic words: a thinking note to answer in Egyptian Arabic", sentOf(s, "session.thinking.append").some((e) => /Egyptian Arabic/.test(e.content)));
    check("never as an instruction (that would cut off what it is saying)", !sentOf(s, "session.instructions.append").some((e) => /Arabic/.test(e.content)));
    c.close("hung-up");
  }

  section("a request said in two pieces is one hand-off");
  {
    const { c, sup } = makeCall({ turnText: "Can you check why the dashboard restarted?" });
    await c.connect();
    const s = lastSession();
    await hear(s, c, "can you check why the");
    await sleep(1650); // GPT-Live's transcript paused: the first piece finishes as a turn
    const end = await hear(s, c, "dashboard restarted", { tl: 2500 });
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg3", type: "delegation", target: "client" } });
    await until(() => sup.calls.some((x) => x[0] === "send"), 5000, "the hand-off");
    const sent = sup.calls.filter((x) => x[0] === "send");
    check("one hand-off for both pieces", sent.length === 1 && c.diag.merged === 1, sent.length + " / merged " + c.diag.merged);
    c.close("hung-up");
  }

  section("nothing grounded: no hand-off, GPT-Live says it did not catch it");
  {
    // A delegation with no words heard at all.
    const { c, sup } = makeCall({ turnText: "a transcription model would have heard this" });
    await c.connect();
    const s = lastSession();
    s.push({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "item_deleg4", type: "delegation", target: "client" } });
    await until(() => sentOf(s, "session.commentary.append").length > 0, 9000, "the commentary");
    check("no words heard: no hand-off", !sup.calls.some((x) => x[0] === "send"));
    const com = sentOf(s, "session.commentary.append")[0];
    check("GPT-Live is given the not-caught line on that delegation", com && com.delegation_id === "item_deleg4" && com.content === desk.linesFor("en").notCaught, JSON.stringify(com));
    c.close("hung-up");
  }
  {
    // GPT-Live's transcript is the transcription prompt echoed back (what noise turns into): the guard refuses it.
    const { c, sup, logs } = makeCall({ turnText: "Restart the dashboard." });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, voice.TRANSCRIBE_PROMPT);
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg6", type: "delegation", target: "client" } });
    await until(() => sentOf(s, "session.commentary.append").length > 0, 9000, "the commentary");
    check("a transcript that echoes a prompt is refused by the guard: no hand-off (and no transcription model to fall back on)", !sup.calls.some((x) => x[0] === "send") && logs.some((l) => /refused by the transcript guard/.test(l)), logs.filter((l) => /hand-off|guard/.test(l)).join(" | "));
    const com = sentOf(s, "session.commentary.append")[0];
    check("  GPT-Live is given the not-caught line", com && com.delegation_id === "item_deleg6" && com.content === desk.linesFor("en").notCaught, JSON.stringify(com));
    c.close("hung-up");
  }

  section("a finished request: the detailed summary goes to GPT-Live, line by line, as one result");
  {
    const asked = [];
    const summarise = async (id, o) => {
      asked.push({ id, o });
      o.onLine({ text: "The dashboard restarted at 02:14 because a deploy ran.", safe: false });
      o.onLine({ text: "It has been up for 9 hours since, with 3 services checked and nothing wrong.", safe: false });
      return { tokens: { text_in: 300, text_out: 40 } };
    };
    const { c, sup, rows } = makeCall({ summarise });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "why did the dashboard restart");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg7", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    const id = [...c.requests.keys()][0];
    sup.replies.set(id, "## Restart\n\nThe dashboard restarted at 02:14 because a deploy ran.\n\n- odoo: up\n- dashboard: up for 9 hours\n- joya-ai: up\n\nNothing is wrong.");
    await until(() => sentOf(s, "session.commentary.append").length >= 2, 3000, "the summary's commentary");
    const coms = sentOf(s, "session.commentary.append").filter((e) => e.delegation_id === "item_deleg7");
    check("the summariser is asked for the request's reply, with what was asked", asked.length === 1 && asked[0].id === id && /dashboard restart/.test(asked[0].o.request) && Array.isArray(asked[0].o.alreadySaid) && asked[0].o.alreadySaid.length === 0, JSON.stringify(asked.map((a) => a.o.request)));
    check("each summary line goes to GPT-Live as commentary on the delegation, in order", coms.length === 2 && /02:14/.test(coms[0].content) && /9 hours/.test(coms[1].content), JSON.stringify(coms.map((x) => x.content)));
    check("  never the details line, never the list itself", !coms.some((x) => /on screen|odoo: up/.test(x.content)));
    check("  one result window: the second line joins the first", c.resultWin && /02:14/.test(c.resultWin.content) && /9 hours/.test(c.resultWin.content) && /9 hours/.test(c.resultWin.reply), c.resultWin && c.resultWin.content);
    check("the summary's tokens are recorded (part desk)", rows.some((r) => r.part === "desk"));
    c.close("hung-up");
  }

  section("2026-10-30: a summary cut part-way -> the rest of the reply word for word, by the reader (not \"the rest is on screen\")");
  {
    const summarise = async (id, o) => {
      o.onLine({ text: "آخر شغل في أودو كان امبارح، 29 أكتوبر.", safe: false });
      o.onLine({ text: "اتعملت كذا نسخة من 4.40 لـ 4.44.", safe: false, verbatim: true });
      o.onLine({ text: "وكلاء GIA بقوا شغالين على Claude Code.", safe: false, verbatim: true });
      return { tokens: { text_in: 300, text_out: 40 }, trip: { rule: "action-claim", rest: 2 } };
    };
    const { c, sup, spoke, logs } = makeCall({ summarise });
    await c.connect();
    const s = lastSession();
    const end = await hear(s, c, "ممكن تقولي آخر حاجة اشتغلنا عليها في أودو");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg9", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    const id = [...c.requests.keys()][0];
    sup.replies.set(id, "آخر شغل في أودو كان امبارح، 29 أكتوبر. اتعملت كذا نسخة من 4.40 لـ 4.44. وكلاء GIA بقوا شغالين على Claude Code.");
    await until(() => sentOf(s, "session.commentary.append").length >= 1, 3000, "the first line");
    await speak(s, "آخر شغل في أودو كان امبارح، 29 أكتوبر.");
    await until(() => spoke.length >= 2, 5000, "the verbatim reader");
    const coms = sentOf(s, "session.commentary.append").filter((e) => e.delegation_id === "item_deleg9").map((e) => e.content);
    check("the released summary line goes to GPT-Live; the rest does NOT (it would paraphrase it again)", coms.length === 1 && /29 أكتوبر/.test(coms[0]), JSON.stringify(coms));
    check("the rest of the reply is read word for word by the verbatim reader, after GPT-Live said the line before it", spoke.join(" | ") === "اتعملت كذا نسخة من 4.40 لـ 4.44. | وكلاء GIA بقوا شغالين على Claude Code.", JSON.stringify(spoke));
    check("  and no \"the rest is on screen\"", !spoke.concat(coms).some((t) => /على الشاشة|on screen/.test(t)));
    check("  logged", logs.some((l) => /cut part-way; the rest of the reply \(2 lines\) is read word for word/.test(l)));
    c.close("hung-up");
  }

  section("2026-10-30: \"the details are on screen\" only when the page showed the reply; the page and panel go with each hand-off");
  {
    const { c, sup } = makeCall();
    await c.connect();
    const s = lastSession();
    check("before the page says it showed a reply, the voice offers the rest instead of pointing at the screen", c.screenLine("en", 5) === "That's the main part; ask me if you want the rest." && /قولّي/.test(c.screenLine("ar", 5)));
    c.message({ type: "reply-shown", turn: 5 });
    check("once the page showed reply 5, its details line points at the screen (and only for 5)", c.screenLine("en", 5) === desk.DETAILS_LINE && c.screenLine("en", 6) !== desk.DETAILS_LINE);
    c.message({ type: "screen", path: "/services", title: "Services \"x\" [y]", panel: "the Decisions sheet" });
    const end = await hear(s, c, "what is on my screen");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg10", type: "delegation", target: "client" } });
    await until(() => sup.calls.some((x) => x[0] === "send"), 4000, "the hand-off");
    const sent = sup.calls.find((x) => x[0] === "send");
    check("the hand-off carries the Joya page and panel in view, after the words, quotes and brackets cleaned", sent && /^what is on my screen\n\n\[Screen: the administrator is looking at the Joya page "Services x y" \(\/services\), with the Decisions sheet open\./.test(sent[1].text), sent && sent[1].text);
    check("  and the call id, so JOYA AI's own small session for this call takes it", sent && sent[1].call === c.id);
    c.close("hung-up");
  }

  section("2026-10-30: the call starts its JOYA AI sessions ahead, and an agent's later reply is said");
  {
    const summarise = async (id, o) => {
      o.onLine({ text: "JOYA Pace says your inbox has nothing urgent.", safe: false });
      return { tokens: { text_in: 100, text_out: 20 } };
    };
    const watchers = new Set(); // the call's own follow-up watcher, and each reply stream's
    const watcher = (ev) => [...watchers].forEach((f) => f(ev));
    const { c, sup, logs: logsG } = makeCall({ summarise });
    c.d.watchTurns = (fn) => (watchers.add(fn), () => watchers.delete(fn));
    await c.connect();
    const s = lastSession();
    check("voice-warm is asked for the call's own sessions as it connects", sup.calls.some((x) => x[0] === "voice-warm" && x[1].call === c.id), JSON.stringify(sup.calls.map((x) => x[0])));
    check("the agents' names are in GPT-Live's prompt (the supervisor's sessions, or the defaults)", /JOYA Pace/.test(s.session.instructions) && /Planning Automation/.test(s.session.instructions));
    check("the prompt gives the exact fillers and forbids saying it asks anyone", /"One second\."/.test(s.session.instructions) && /ثانية واحدة/.test(s.session.instructions) && /Never say you will ask, check with, consult or hear back from anyone/.test(s.session.instructions));
    const end = await hear(s, c, "ask joya pace if my inbox has anything urgent");
    s.push({ type: "session.delegation.created", offset_ms: end + 200, delegation: { id: "item_deleg11", type: "delegation", target: "client" } });
    await until(() => c.requests.size > 0, 4000, "the hand-off");
    const id = [...c.requests.keys()][0];
    sup.replies.set(id, "I sent it to JOYA Pace and asked whether your inbox has anything urgent.");
    sup.replies.set(9001, "JOYA Pace says your inbox has nothing urgent.");
    watcher({ type: "result", turn: { id: 9001, call_id: "lvOTHER", follows: id, source: "peer", result_text: "x" } });
    watcher({ type: "result", turn: { id: 9001, call_id: c.id, follows: id, source: "idle", result_text: "x" } });
    check("another call's turn, or an idle notice, is not said", !c.requests.has(9001));
    watcher({ type: "result", turn: { id: 9001, call_id: c.id, follows: id, source: "peer", actor: "JOYA Pace", result_text: "JOYA Pace says your inbox has nothing urgent." } });
    await until(() => sentOf(s, "session.commentary.append").some((e) => /nothing urgent/.test(e.content)), 3000, "the agent's reply as a result");
    check("the agent's reply to this call's request is said like any result (the detailed summary, as commentary)", sentOf(s, "session.commentary.append").some((e) => /nothing urgent/.test(e.content)) && c.requests.get(9001) && c.requests.get(9001).followUp, JSON.stringify(sentOf(s, "session.commentary.append")) + " " + JSON.stringify(logsG.slice(-8)));
    c.close("hung-up");
    check("the call stops watching when it ends", watchers.size === 0, watchers.size);
  }

  section("the spoken stop command ends the call");
  {
    const { c, client } = makeCall();
    await c.connect();
    const s = lastSession();
    await hear(s, c, "stop listening");
    await until(() => c.closed, 3000, "the end");
    check("stop listening ends it (voice-command)", c.closed && c.endWhy.why === "voice-command" && client.json.some((m) => m.type === "stop"));
  }

  section("a voice change to a realtime model ends a GPT-Live call (and the other way round)");
  {
    const { c, client } = makeCall();
    await c.connect();
    const r = await c.swapUpstream({ live_model: "gpt-realtime-2.1-mini" });
    check("the GPT-Live call ends with voice-changed", !r.ok && c.closed && c.endWhy.why === "voice-changed" && client.json.some((m) => m.type === "ended"));
    const src = fs.readFileSync(path.join(ROOT, "lib", "voice-live.js"), "utf8");
    check("a realtime call asked to become GPT-Live ends too", /\/\^gpt-live\/\.test\(String\(patch\.live_model\)\) && this\.kind !== "gpt-live"/.test(src));
  }

  section("the voiceprint in front of GPT-Live: an unknown voice is heard as silence, a stored one as it is");
  {
    // A tone of 3000 is the administrator, 7000 someone else (the fake voiceprint tells them apart by loudness).
    const checked = [];
    const records = [];
    const vp = {
      enabled: () => true,
      hasPrints: () => true,
      gate: () => vpGate,
      check: async (pcm, o) => {
        checked.push({ ms: pcm.length / 48, o });
        const known = gl.rmsOf(pcm) < 5000;
        return known ? { verdict: "accept", score: 0.5, speaker: { id: "p1", name: "Abdul", spoken: "", may_command: true }, speech_ms: 1000, ms: 20 } : { verdict: "reject", score: 0.08, speech_ms: 1000, ms: 20 };
      },
      record: (r) => records.push(r),
    };
    let vpGate = true;
    const { c, client, logs } = makeCall({ voiceprint: vp });
    await c.connect();
    const s = lastSession();
    for (let i = 0; i < 10; i++) c.audioIn(tone(20, 30)); // a quiet room
    await sleep(20);
    let loud0 = s.appended - s.silentBytes;
    const sil0 = s.silentBytes;
    for (let i = 0; i < 6; i++) c.audioIn(tone(100, 7000)); // 600 ms of another voice: held, not relayed
    await sleep(20);
    check("speech is held while it is checked (nothing of it reaches GPT-Live yet)", s.appended - s.silentBytes === loud0 && !checked.length);
    check("but GPT-Live's input never stops: silence in its place, frame by frame (it only talks while it hears)", s.silentBytes - sil0 >= 600 * 48, s.silentBytes - sil0);
    for (let i = 0; i < 6; i++) c.audioIn(tone(100, 7000));
    await until(() => checked.length >= 1, 1000, "the check");
    await sleep(30);
    check("checked after ~1 s of speech", checked.length === 1 && checked[0].ms >= 1000 && checked[0].ms <= 1300, checked[0] && checked[0].ms);
    check("an unknown voice: GPT-Live hears silence of the same length (held audio and what follows)", s.appended - s.silentBytes === loud0 && s.silentBytes - sil0 >= 1200 * 48, s.silentBytes - sil0);
    for (let i = 0; i < 5; i++) c.audioIn(tone(100, 7000));
    await sleep(20);
    check("the rest of that segment is silence too", s.appended - s.silentBytes === loud0);
    check("logged, the page's pill told, the ledger written", logs.some((l) => /speech gate, segment 1: reject, unknown voice.*hears silence/.test(l)) && client.json.some((m) => m.type === "voiceprint" && m.kind === "other" && m.gated) && records.some((r) => r.acted === "not heard by the live voice"));
    for (let i = 0; i < 10; i++) c.audioIn(tone(100, 30)); // a pause ends the segment
    loud0 = s.appended - s.silentBytes;
    for (let i = 0; i < 12; i++) c.audioIn(tone(100, 3000)); // the administrator
    await until(() => checked.length >= 2, 1000, "the second check");
    await sleep(30);
    check("a stored voice: the held audio is relayed whole, at once", s.appended - s.silentBytes - loud0 >= 1200 * 48, s.appended - s.silentBytes - loud0);
    c.audioIn(tone(100, 3000));
    await sleep(10);
    check("and the segment goes on live, the speaker known to the call", s.appended - s.silentBytes - loud0 >= 1300 * 48 && c.vpSpeaker && c.vpSpeaker.name === "Abdul" && checked.length === 2);
    // Switched off mid-segment: what is held goes through.
    for (let i = 0; i < 10; i++) c.audioIn(tone(100, 30));
    loud0 = s.appended - s.silentBytes;
    for (let i = 0; i < 4; i++) c.audioIn(tone(100, 7000));
    vpGate = false;
    c.audioIn(tone(100, 7000));
    await sleep(20);
    check("gate switched off mid-segment: the held audio and the rest are relayed", s.appended - s.silentBytes - loud0 >= 500 * 48 && checked.length === 2);
    c.close("hung-up");
  }
  {
    // The service hangs: fail open after CHECK_WAIT_MS.
    const vp = { enabled: () => true, hasPrints: () => true, gate: () => true, check: () => new Promise(() => {}), record: () => {} };
    const { c, logs } = makeCall({ voiceprint: vp });
    await c.connect();
    const s = lastSession();
    for (let i = 0; i < 10; i++) c.audioIn(tone(20, 30));
    const loud0 = s.appended - s.silentBytes;
    for (let i = 0; i < 12; i++) c.audioIn(tone(100, 3000));
    await sleep(sg.CHECK_WAIT_MS + 150);
    check("the voiceprint not answering: fail open, the speech is relayed", s.appended - s.silentBytes - loud0 >= 1200 * 48 && logs.some((l) => /speech gate.*error.*hears it/.test(l)));
    c.close("hung-up");
  }
  {
    // Shadow (gate off): nothing is held, nothing is checked here.
    let n = 0;
    const vp = { enabled: () => true, hasPrints: () => true, gate: () => false, check: async () => (n++, { verdict: "reject" }), record: () => {} };
    const { c } = makeCall({ voiceprint: vp });
    await c.connect();
    const s = lastSession();
    const loud0 = s.appended - s.silentBytes;
    c.audioIn(tone(100, 7000));
    await sleep(20);
    check("gate off (shadow): the microphone is relayed at once, no check before GPT-Live", s.appended - s.silentBytes - loud0 >= 100 * 48 && n === 0);
    c.close("hung-up");
  }

  section("while it talks, only a recognised voice stops it (gate on)");
  for (const mode of ["mic", "page"]) {
    const vp = {
      enabled: () => true,
      hasPrints: () => true,
      gate: () => true,
      check: async (pcm) => (((x) => x > 1000 && x < 5000)(gl.rmsOf(pcm.subarray(pcm.length - 4800))) ? { verdict: "accept", score: 0.5, speaker: { id: "p1", name: "Abdul", spoken: "", may_command: true } } : { verdict: "reject", score: 0.05 }),
      record: () => {},
    };
    const { c, client, logs } = makeCall({ voiceprint: vp });
    await c.connect();
    const s = lastSession();
    for (let i = 0; i < 10; i++) c.audioIn(tone(20, 30));
    const p = speak(s, "Once upon a time there was a server that never slept and always answered every single question it was asked.", { gap: 80 });
    await until(() => client.audio.length >= 2, 2000, "audio");
    for (let i = 0; i < 4; i++) c.audioIn(tone(100, 7000)); // someone else talks over it
    if (mode === "page") c.message({ type: "voice", on: true });
    await sleep(40);
    check(`${mode}: an unknown voice over it does not stop it`, !client.json.some((m) => m.type === "flush") && logs.some((l) => /not a barge-in.*reject.*keeps talking/.test(l)));
    for (let i = 0; i < 8; i++) c.audioIn(tone(100, 30)); // quiet: the ring moves on
    c.bargeNextAt = 0; // past the re-check pause (it would still be talking in a real call)
    const raw = c.rawMic.length;
    c.rawMic = []; // the next check hears only the administrator
    for (let i = 0; i < 4; i++) c.audioIn(tone(100, 3000));
    if (mode === "page") c.message({ type: "voice", on: true });
    await until(() => client.json.some((m) => m.type === "flush"), 1000, "the stop").catch(() => {});
    check(`${mode}: the administrator's voice over it stops it`, raw > 0 && client.json.some((m) => m.type === "flush") && logs.some((l) => /barge-in \(.*voiceprint accept, Abdul/.test(l)));
    await p;
    c.close("hung-up");
  }

  section("helpers");
  {
    const long = Array.from({ length: 90 }, (_, i) => "Sentence number " + (i + 1) + " is here.").join(" ");
    const parts = gl.chunksOf(long);
    check("a long result is split into appends under the 500-token limit, on sentence boundaries", parts.length > 1 && parts.every((p) => p.length <= 1200 && /\.$/.test(p)));
    check("rmsOf: silence is 0, a tone is loud", gl.rmsOf(Buffer.alloc(960)) === 0 && gl.rmsOf(tone(20)) > gl.LOUD_RMS);
  }

  mockServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("crashed: " + e.stack);
  process.exit(1);
});
