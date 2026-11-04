#!/usr/bin/env node
"use strict";
/**
 * Tests for the OpenAI voice: lib/voice.js against a mock OpenAI, the helper's
 * key storage, and the views' no-key state.
 *
 *   node dashboard/tools/test-voice.cjs
 *
 * The mock speaks the protocols lib/voice.js implements -- the Realtime API as
 * captured from the real gpt-realtime-mini on 2026-09-27 (session.created,
 * session.updated, then per response.create: response.created,
 * output_item.added, content_part.added, output_audio(_transcript).delta ...,
 * output_audio.done, output_audio_transcript.done, content_part.done,
 * output_item.done, response.done, rate_limits.updated; several responses per
 * socket), GPT-Live (session.start, commentary with delegation_id: null, audio
 * only while silence frames arrive), /audio/speech (the text-to-speech
 * fallback) and the transcription endpoint. Like the real model, it ANSWERS a
 * sentence put in as a user message and reads only an out-of-band response
 * whose instructions quote the text. It can be told to improvise, to refuse
 * the key, to not know the model, or to hang.
 *
 * The helper part loads deploy/joya-helper as a Python module with its voice
 * file pointed into a temp directory, so nothing on the machine is touched.
 * No real key is used anywhere: the keys below are made up.
 *
 * .cjs because it uses require. Needs `ws` on NODE_PATH and python3.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const voice = require(path.join(ROOT, "lib", "voice.js"));
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}
function section(t) {
  console.log("\n" + t);
}

const GOOD = "sk-proj-" + "T".repeat(40) + "good";
const BAD = "sk-proj-" + "B".repeat(40) + "nope";

/* ---------------------------------------------------------------- mock --- */

const mock = {
  mode: "faithful", // faithful | improvise | improvise-once | answer | model-error | hang | handshake-401 | drift | drop | die | odd
  connections: 0,
  log: [], // per connection: { url, headers, events: [], closedEarly }
  heard: null, // the last text "spoken", returned by transcription of a RIFF upload
  transcriptions: [],
  responses: 0, // response.create calls, across sockets
  speech: [], // /audio/speech calls
  speechMode: "ok", // ok | 401 | raw (a plain PCM body, no usage)
  cancels: [], // response.cancel events received
  timeline: [], // [what, ms] for the streaming tests
};
const USAGE_RT = { total_tokens: 208, input_tokens: 120, output_tokens: 88, input_token_details: { text_tokens: 120, audio_tokens: 0, cached_tokens: 64, cached_tokens_details: { text_tokens: 64, audio_tokens: 0 } }, output_token_details: { text_tokens: 22, audio_tokens: 66 } };
const USAGE_CANCELLED = { total_tokens: 150, input_tokens: 120, output_tokens: 30, input_token_details: { text_tokens: 120, audio_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } }, output_token_details: { text_tokens: 10, audio_tokens: 20 } };
const USAGE_TTS = { input_tokens: 12, output_tokens: 83, total_tokens: 95 };

function speechChunk(loud) {
  const b = Buffer.alloc(4800); // 100 ms of PCM16 at 24 kHz
  if (loud) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 === 0 ? 6000 : -6000, i);
  return b.toString("base64");
}

function readingFor(text, conn) {
  if (mock.mode === "improvise" || (mock.mode === "improvise-once" && conn === 1)) {
    return "Sure! " + text + " Is there anything else I can help you with today, or shall I carry on?";
  }
  if (mock.mode === "answer") return "Yes, I restarted it for you a moment ago and everything looks healthy now.";
  // Reads the sentence faithfully, then carries on with words of its own.
  if (mock.mode === "drift") return text + " And by the way I also went ahead and restarted every single service for you just now.";
  // Reads only the first half: nothing added, too much missing (the end check).
  if (mock.mode === "drop") return text.split(" ").slice(0, Math.ceil(text.split(" ").length / 2)).join(" ");
  return text;
}

/** What the real model does with a sentence handed over as a user message. */
function answerTo() {
  return "Yes, I can hear you loud and clear. How can I assist you today?";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    // The model listing (ids only), as the real endpoint returns it.
    mock.modelsGets = (mock.modelsGets || 0) + 1;
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer " + GOOD) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****nope." } }));
    }
    const ids = mock.modelIds || ["gpt-realtime-mini", "gpt-realtime-2.1-mini", "gpt-4o-mini-transcribe"];
    return res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "system" })) }));
  }
  if (req.method === "POST" && req.url === "/v1/audio/speech") {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      mock.speech.push({ auth: req.headers.authorization, ...body });
      if (req.headers.authorization !== "Bearer " + GOOD || mock.speechMode === "401") {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****nope." } }));
      }
      mock.heard = body.input;
      if (body.stream_format === "sse" && mock.speechMode !== "raw") {
        // As the real endpoint streams it: CRLF-separated events, audio in
        // pieces, then the usage, then [DONE].
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        const pcm = Buffer.from(speechChunk(true), "base64");
        const parts = [pcm.subarray(0, 1601), pcm.subarray(1601, 3000), pcm.subarray(3000)];
        let k = 0;
        const next = () => {
          if (k < parts.length) {
            res.write("data: " + JSON.stringify({ type: "speech.audio.delta", audio: parts[k++].toString("base64") }) + "\r\n\r\n");
            return setTimeout(next, 5);
          }
          res.write("data: " + JSON.stringify({ type: "speech.audio.done", usage: USAGE_TTS }) + "\r\n\r\ndata: [DONE]\r\n\r\n");
          res.end();
        };
        return next();
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(Buffer.from(speechChunk(true), "base64"));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || "";
      const txt = body.toString("latin1");
      const model = (txt.match(/name="model"\r\n\r\n([^\r]*)/) || [])[1];
      const ctype = (txt.match(/name="file"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)/) || []).slice(1);
      const prompt = (txt.match(/name="prompt"\r\n\r\n([^\r]*)/) || [])[1];
      mock.transcriptions.push({ auth, model, prompt, filename: ctype[0], type: ctype[1], bytes: body.length });
      res.setHeader("Content-Type", "application/json");
      if (auth !== "Bearer " + GOOD) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****nope.", code: "invalid_api_key" } }));
      }
      if (model === "gpt-nonexistent-transcribe") {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { message: "The model does not exist", code: "model_not_found" } }));
      }
      const isWav = txt.includes("RIFF") && txt.includes("WAVE");
      res.end(JSON.stringify({ text: isWav ? mock.heard || "" : "restart the dashboard please", usage: { type: "tokens", total_tokens: 44, input_tokens: 32, input_token_details: { text_tokens: 0, audio_tokens: 32 }, output_tokens: 12 } }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (mock.mode === "handshake-401") {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
        JSON.stringify({ error: { message: "You didn't provide an API key (sk-proj-" + "Z".repeat(30) + ")." } })
    );
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const conn = ++mock.connections;
  const entry = { url: req.url, headers: req.headers, events: [], closedEarly: false, finished: false };
  mock.log.push(entry);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const authed = req.headers.authorization === "Bearer " + GOOD;

  if (req.url.startsWith("/v1/realtime")) {
    if (!authed) {
      // What the real endpoint does: upgrade, then an error event, then close.
      send({ type: "error", error: { type: "invalid_request_error", code: null, message: "Missing bearer or basic authentication in header" } });
      return setTimeout(() => ws.close(), 20);
    }
    send({ type: "session.created", event_id: "e0", session: {} });
    let userText = null;
    let n = 0;
    ws.on("message", (raw) => {
      const ev = JSON.parse(String(raw));
      entry.events.push(ev);
      if (ev.type === "session.update") send({ type: "session.updated", session: ev.session });
      if (ev.type === "conversation.item.create") {
        userText = ev.item.content[0].text;
        send({ type: "conversation.item.added", item: ev.item });
        send({ type: "conversation.item.done", item: ev.item });
      }
      if (ev.type === "response.cancel") {
        mock.cancels.push(ev);
        entry.cancelled = true;
        return;
      }
      if (ev.type === "response.create") {
        mock.responses++;
        entry.cancelled = false;
        if (mock.mode === "model-error") return send({ type: "error", error: { code: "model_not_found", message: "The model gpt-nope does not exist" } });
        if (mock.mode === "hang") return;
        const r = ev.response || {};
        const quoted = /"""\n([\s\S]*)\n"""$/.exec(r.instructions || "");
        const outOfBand = r.conversation === "none" && quoted;
        // In band, the real model takes the text as something said to it.
        const reading = outOfBand ? readingFor(quoted[1], conn) : answerTo(userText);
        const rid = "resp_" + conn + "_" + ++n;
        entry.finished = false;
        send({ type: "response.created", response: { id: rid, status: "in_progress", output_modalities: ["audio"] } });
        entry.rid = rid;
        send({ type: "response.output_item.added", response_id: rid, item: { type: "message", role: "assistant" } });
        send({ type: "response.content_part.added", response_id: rid, part: { type: "audio", transcript: "" } });
        const parts = reading.match(/\S+\s*/g) || [];
        let i = 0;
        const step = () => {
          if (ws.readyState !== 1) {
            entry.closedEarly = i < parts.length;
            return;
          }
          if (entry.cancelled) {
            // What the real API does with response.cancel {response_id}: a
            // response.done, status cancelled, with the usage so far.
            entry.closedEarly = i < parts.length;
            entry.finished = true;
            mock.timeline.push(["cancelled", Date.now()]);
            return send({ type: "response.done", response: { id: rid, status: "cancelled", usage: USAGE_CANCELLED } });
          }
          if (mock.mode === "die" && i === 3) {
            mock.timeline.push(["died", Date.now()]);
            return ws.terminate();
          }
          if (i < parts.length) {
            send({ type: "response.output_audio_transcript.delta", response_id: rid, delta: parts[i] });
            const chunk = Buffer.from(speechChunk(true), "base64");
            send({ type: "response.output_audio.delta", response_id: rid, delta: (mock.mode === "odd" ? chunk.subarray(0, 4801) : chunk).toString("base64") });
            mock.timeline.push(["audio", Date.now()]);
            i++;
            return setTimeout(step, 5);
          }
          send({ type: "response.output_audio.done", response_id: rid });
          send({ type: "response.output_audio_transcript.done", response_id: rid, transcript: reading });
          send({ type: "response.content_part.done", response_id: rid, part: { type: "audio", transcript: reading } });
          send({ type: "response.output_item.done", response_id: rid });
          entry.finished = true;
          mock.heard = reading;
          mock.timeline.push(["done", Date.now()]);
          send({ type: "response.done", response: { id: rid, status: "completed", usage: USAGE_RT } });
          send({ type: "rate_limits.updated", rate_limits: [] });
        };
        step();
      }
    });
    ws.on("close", () => {
      if (!entry.finished) entry.closedEarly = true;
    });
    return;
  }

  if (req.url.startsWith("/v1/live/sessions")) {
    if (!authed) {
      send({ type: "error", error: { message: "Incorrect API key provided" } });
      return setTimeout(() => ws.close(), 20);
    }
    let text = null;
    let frames = 0;
    let said = 0;
    ws.on("message", (raw) => {
      const ev = JSON.parse(String(raw));
      entry.events.push(ev);
      if (ev.type === "session.start") send({ type: "session.started" });
      if (ev.type === "session.commentary.append") text = ev.content;
      if (ev.type === "session.input_audio.append" && text != null) {
        // It speaks only while it hears: one chunk of output per frame in.
        frames++;
        const words = readingFor(text, conn).split(" ");
        if (said < words.length) {
          send({ type: "session.output_transcript.delta", delta: (said ? " " : "") + words[said] });
          send({ type: "session.output_audio.delta", delta: speechChunk(true) });
          said++;
          if (said === words.length) mock.heard = readingFor(text, conn);
        } else {
          send({ type: "session.output_audio.delta", delta: speechChunk(false) });
        }
      }
    });
    entry.frames = () => frames;
    return;
  }
  ws.close();
});

/* --------------------------------------------------------------- tests --- */

async function expectCode(p, code) {
  try {
    await p;
    return { ok: false, got: "resolved" };
  } catch (e) {
    return { ok: e.code === code, got: e.code + ": " + e.message, e };
  }
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = { httpBase: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` };
  const cfg = (extra) => ({ ...base, key: GOOD, model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe", ...extra });
  const allMessages = [];

  section("verbatim guard");
  const f = voice.faithful;
  check("an exact reading passes", f("The dashboard is up.", "The dashboard is up.").ok);
  check("case and punctuation do not matter", f("Restart it, now!", "restart it now").ok);
  check("numbers read as words pass", f("I found 3 sessions and 12 agents.", "I found three sessions and twelve agents.").ok);
  check("an acronym read letter by letter passes", f("Check the MRP queue.", "Check the M R P queue.").ok);
  check(
    "a continuation is rejected",
    !f("The service restarted.", "The service restarted. Would you like me to check the logs as well, or anything else?").ok
  );
  check("an answer instead of the text is rejected", !f("Do you want me to restart it?", "Yes, I will restart it right away for you.").ok);
  check("a reading that drops half the sentence is rejected", !f("Three sessions are running and two are waiting for approval.", "Three sessions are running.").ok);
  check("an empty reading is rejected", !f("Hello there.", "").ok);
  check("a short ack must be read whole", f("On it.", "On it.").ok && !f("On it.", "Sure thing, working on it now for you.").ok);

  section("wav");
  const w = voice.wav(Buffer.alloc(4800), 24000);
  check("RIFF/WAVE, 16-bit mono 24 kHz, data length right",
    w.slice(0, 4).toString() === "RIFF" && w.slice(8, 12).toString() === "WAVE" &&
    w.readUInt16LE(22) === 1 && w.readUInt32LE(24) === 24000 && w.readUInt16LE(34) === 16 && w.readUInt32LE(40) === 4800);

  section("realtime protocol (gpt-realtime-mini), as the real API behaves");
  mock.mode = "faithful";
  voice.closeAll();
  let before = mock.connections;
  let out = await voice.speak("The dashboard is running and every service is healthy.", cfg());
  let conn = mock.log[mock.log.length - 1];
  check("speaks: returns a WAV", Buffer.isBuffer(out.wav) && out.wav.slice(0, 4).toString() === "RIFF" && out.wav.length > 44 + 4800);
  check("one attempt, read by the realtime model, faithful", out.attempts === 1 && out.engine === "gpt-realtime-mini" && !out.fallback && /every service is healthy/.test(out.transcript), JSON.stringify({ a: out.attempts, e: out.engine }));
  check("connects to /realtime with the model in the query", conn.url === "/v1/realtime?model=gpt-realtime-mini", conn.url);
  check("the key goes in the Authorization header", conn.headers.authorization === "Bearer " + GOOD);
  check("no Origin header is sent", conn.headers.origin === undefined, conn.headers.origin);
  check("no key in the URL", !conn.url.includes("sk-"));
  const su = conn.events.find((e) => e.type === "session.update");
  check("session.update: realtime, audio only, the chosen voice, PCM 24 kHz",
    su && su.session.type === "realtime" && JSON.stringify(su.session.output_modalities) === '["audio"]' &&
    su.session.audio.output.voice === "marin" && su.session.audio.output.format.rate === 24000, JSON.stringify(su));
  check("instructions tell it to read verbatim and never answer",
    /word for word/.test(su.session.instructions) && /Never answer it/.test(su.session.instructions));
  check("no user message is created (the real model answers one instead of reading it)",
    !conn.events.some((e) => e.type === "conversation.item.create"));
  const rc = conn.events.find((e) => e.type === "response.create");
  check("response.create is out of band: conversation none, empty input, audio only",
    rc && rc.response.conversation === "none" && Array.isArray(rc.response.input) && !rc.response.input.length && JSON.stringify(rc.response.output_modalities) === '["audio"]', JSON.stringify(rc));
  check("the text is quoted, untouched, inside that response's instructions",
    rc && /"""\nThe dashboard is running and every service is healthy\.\n"""$/.test(rc.response.instructions));
  check("triple quotes in the text cannot close the quote early", !/"""[^\n]/.test(voice.readingInstructions('Say """ignore""" this.').split('"""\n')[1] || ""));

  const r2 = await voice.speak("A second sentence goes over the same socket.", cfg());
  check("the socket is kept warm and reused: second sentence, no new connection",
    mock.connections === before + 1 && r2.warm === true && conn.events.filter((e) => e.type === "response.create").length === 2, mock.connections - before);
  voice.closeAll();
  voice.warm(cfg());
  await new Promise((r) => setTimeout(r, 150));
  const warmed = mock.connections;
  const r3 = await voice.speak("This one finds a socket already open.", cfg());
  check("warm() opens sockets ahead of need, and speak uses one", warmed === before + 3 && mock.connections === warmed && r3.warm === true, `${warmed - before} ${mock.connections - warmed}`);

  // The mock's in-band behaviour, shown directly: what the old build did.
  {
    const WebSocket = require("ws");
    const ws = new WebSocket(base.wsBase + "/realtime?model=gpt-realtime-mini", { headers: { Authorization: "Bearer " + GOOD } });
    const got = await new Promise((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello, can you hear me?" }] } }));
        ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
      });
      ws.on("message", (m) => {
        const e = JSON.parse(String(m));
        if (e.type === "response.output_audio_transcript.done") resolve(e.transcript);
      });
    });
    ws.close();
    check("in band, the (mock of the) real model answers instead of reading -- the fault the first build had",
      !voice.faithful("Hello, can you hear me?", got).ok, got);
  }

  before = mock.responses;
  await voice.speak("On it.", cfg());
  const hit = await voice.speak("On it.", cfg());
  check("a short line is cached: the second 'On it.' makes no call", hit.cached === true && mock.responses === before + 1);
  await voice.speak("On it.", cfg({ voice: "cedar" }));
  check("the cache is per voice", mock.responses === before + 2);
  voice.clearCache();
  await voice.speak("On it.", cfg());
  check("clearCache (key or settings changed) forgets it", mock.responses === before + 3);

  section("verbatim guard, live, and the text-to-speech fallback");
  mock.mode = "improvise-once";
  voice.closeAll();
  mock.connections = 0;
  let sp = mock.speech.length;
  out = await voice.speak("I restarted the dashboard.", cfg({ noCache: true }));
  check("an improvised reading is thrown away and the sentence read by gpt-4o-mini-tts instead",
    out.fallback === true && out.engine === "gpt-4o-mini-tts" && mock.speech.length === sp + 1 && out.wav.length > 44, JSON.stringify({ f: out.fallback, e: out.engine }));
  const tts = mock.speech[mock.speech.length - 1];
  check("  the fallback gets the text as input, the same voice, raw PCM, the key as bearer",
    tts.input === "I restarted the dashboard." && tts.voice === "marin" && tts.response_format === "pcm" && tts.model === "gpt-4o-mini-tts" && tts.auth === "Bearer " + GOOD, JSON.stringify(tts));
  const cutConn = mock.log[mock.log.length - 1];
  check("the improvising reading was cut short, not paid for to the end: response.cancel with its id",
    cutConn.closedEarly === true && mock.cancels.length > 0 && mock.cancels[mock.cancels.length - 1].response_id === cutConn.rid, JSON.stringify(mock.cancels.slice(-1)));
  const late = await out.lateBilling;
  check("  and what the cut reading cost is still counted, from the cancelled response's usage",
    late.length === 1 && late[0].model === "gpt-realtime-mini" && late[0].tokens.audio_out === 20 && late[0].tokens.text_in === 120, JSON.stringify(late));
  check("  the fallback's own usage (speech.audio.done) is in the billing",
    out.billing.some((b) => b.model === "gpt-4o-mini-tts" && b.tokens.text_in === 12 && b.tokens.audio_out === 83), JSON.stringify(out.billing));

  mock.mode = "improvise";
  out = await voice.speak("The backup finished.", cfg({ noCache: true }));
  check("a voice that keeps improvising: the sentence is still spoken, by the fallback", out.fallback === true);
  let r = await expectCode(voice.speak("The backup finished.", cfg({ noCache: true, fallback: false })), "unfaithful");
  check("with the fallback off: rejected as unfaithful, nothing returned", r.ok, r.got);
  allMessages.push(r.e && r.e.message);
  mock.mode = "answer";
  out = await voice.speak("Do you want me to restart the dashboard?", cfg({ noCache: true }));
  check("a voice that answers the question instead of reading it: fallback reads it", out.fallback === true && mock.heard === "Do you want me to restart the dashboard?");
  mock.speechMode = "401";
  r = await expectCode(voice.speak("Do you want me to restart it now?", cfg({ noCache: true })), "auth");
  check("a fallback that fails reports its error", r.ok, r.got);
  check("  and never carries a key", r.e && !/sk-proj-\*\*\*\*nope/.test(r.e.message) && !r.e.message.includes(GOOD), r.e && r.e.message);
  mock.speechMode = "ok";

  section("streaming: audio passed on as it arrives, the verbatim check running alongside");
  {
    const record = () => {
      const ev = [];
      return {
        ev,
        sink: {
          start: (x) => ev.push(["start", x.engine, Date.now()]),
          audio: (b) => ev.push(["audio", b.length, Date.now()]),
          cut: (x) => ev.push(["cut", x.why, Date.now()]),
        },
      };
    };
    mock.mode = "faithful";
    mock.timeline = [];
    let rec = record();
    const text = "Every service on this machine is healthy and nothing needs your attention right now.";
    const res = await voice.speakStream(text, cfg({ noCache: true }), rec.sink);
    const audios = rec.ev.filter((e) => e[0] === "audio");
    const doneAt = (mock.timeline.find((t) => t[0] === "done") || [])[1];
    check("speakStream: a start, then audio chunk by chunk, no cut", rec.ev[0][0] === "start" && rec.ev[0][1] === "gpt-realtime-mini" && audios.length >= 10 && !rec.ev.some((e) => e[0] === "cut"), JSON.stringify(rec.ev.map((e) => e[0])));
    check("  the first chunk is passed on before the reading has finished upstream", doneAt && audios[0][2] < doneAt, `${audios[0] && audios[0][2]} vs ${doneAt}`);
    check("  every chunk is whole samples (even length)", audios.every((a) => a[1] % 2 === 0));
    check("  resolves with the realtime usage as billing, firstAudioMs, no cuts",
      res.billing.length === 1 && res.billing[0].tokens.text_cached === 64 && res.billing[0].tokens.text_in === 56 && res.billing[0].tokens.audio_out === 66 && res.firstAudioMs != null && res.cuts === 0 && !res.fallback, JSON.stringify(res.billing));

    mock.mode = "odd";
    rec = record();
    await voice.speakStream("The disk is at sixty one percent.", cfg({ noCache: true }), rec.sink);
    const oddAudio = rec.ev.filter((e) => e[0] === "audio");
    check("odd-sized chunks upstream still reach the sink as whole samples", oddAudio.length > 0 && oddAudio.every((a) => a[1] % 2 === 0), oddAudio.map((a) => a[1]).join(","));

    // Mid-clip failure 1: the transcript runs off script while audio flows.
    mock.mode = "drift";
    mock.cancels = [];
    rec = record();
    const t2 = "Three sessions are running and two are waiting for your approval.";
    const r2 = await voice.speakStream(t2, cfg({ noCache: true }), rec.sink);
    const kinds = rec.ev.map((e) => e[0] + (e[0] === "start" ? ":" + e[1] : ""));
    const cutIdx = kinds.indexOf("cut");
    check("a reading that drifts off script mid-clip: audio first, then a cut, then the fallback from the start",
      kinds[0] === "start:gpt-realtime-mini" && cutIdx > 1 && kinds.slice(1, cutIdx).every((k) => k === "audio") && kinds[cutIdx + 1] === "start:gpt-4o-mini-tts" && kinds.slice(cutIdx + 2).length > 0 && kinds.slice(cutIdx + 2).every((k) => k === "audio"), kinds.join(" "));
    check("  cut as soon as the transcript showed it, not at the end: the response was cancelled", mock.cancels.length === 1 && r2.cuts === 1 && r2.fallback === true && r2.why === "unfaithful");
    check("  the fallback read the whole sentence, verbatim by design", mock.heard === t2);
    let whole = await voice.speak(t2, cfg({ noCache: true }));
    const fallbackBytes = Buffer.from(speechChunk(true), "base64").length;
    check("  speak() (the WAV form) keeps only what survived the cut: the fallback's reading", whole.fallback === true && whole.wav.length - 44 === fallbackBytes, `${whole.wav.length - 44} vs ${fallbackBytes}`);

    // Mid-clip failure 2: nothing added, but half the sentence missing -- only
    // the end check can see it, after the audio has gone out.
    mock.mode = "drop";
    rec = record();
    const r3 = await voice.speakStream("The backup finished at three and every table was copied across cleanly.", cfg({ noCache: true }), rec.sink);
    const k3 = rec.ev.map((e) => e[0] + (e[0] === "start" ? ":" + e[1] : ""));
    check("a reading that drops words: every chunk goes out, the end check cuts it, the fallback follows",
      k3[0] === "start:gpt-realtime-mini" && k3.includes("cut") && k3[k3.indexOf("cut") + 1] === "start:gpt-4o-mini-tts" && r3.fallback === true && r3.cuts === 1, k3.join(" "));

    // With the fallback off: cut, then skipped (rejected), text stays on screen.
    mock.mode = "drift";
    rec = record();
    const r4 = await expectCode(voice.speakStream(t2, cfg({ noCache: true, fallback: false }), rec.sink), "unfaithful");
    check("with the fallback off: the cut still comes first, then it is rejected as unfaithful", r4.ok && rec.ev.some((e) => e[0] === "cut") && rec.ev[rec.ev.length - 1][0] === "cut", r4.got);

    // A socket that dies mid-reading after audio went out: cut and fall back,
    // rather than leave half a sentence in the air.
    mock.mode = "die";
    rec = record();
    const r5 = await voice.speakStream("Memory is fine and the swap is almost unused today.", cfg({ noCache: true }), rec.sink);
    check("a reading that breaks mid-way (socket gone): cut, then the fallback reads it", r5.fallback === true && rec.ev.some((e) => e[0] === "cut") && ["upstream", "network"].includes(r5.why), JSON.stringify({ why: r5.why, k: rec.ev.map((e) => e[0]).join(" ") }));

    // The text-to-speech stream, both shapes.
    mock.mode = "improvise";
    mock.speechMode = "raw";
    const r6 = await voice.speakStream("The dashboard is up.", cfg({ noCache: true }), record().sink);
    check("a plain PCM fallback body (no usage) still streams, and is estimated and marked", r6.fallback === true && r6.billing.some((b) => b.model === "gpt-4o-mini-tts" && b.tokens.estimated === 1), JSON.stringify(r6.billing));
    mock.speechMode = "ok";
    const sse = mock.speech[mock.speech.length - 1];
    check("the fallback asks for PCM as server-sent events (that is where its usage is)", sse.stream_format === "sse" && sse.response_format === "pcm");

    // A cached line streams too: one start, one chunk.
    mock.mode = "faithful";
    await voice.speak("On it.", cfg());
    rec = record();
    const r7 = await voice.speakStream("On it.", cfg(), rec.sink);
    check("a cached line: start(cache) and its audio in one chunk, costing nothing", r7.cached === true && rec.ev[0][1] === "cache" && rec.ev.filter((e) => e[0] === "audio").length === 1 && r7.billing.length === 0);

    check("overrun(): a word still arriving is not counted yet", voice.overrun("The dashboard is up.", "The dash") === false && voice.overrun("The dashboard is up.", "Sure thing! Of course, here you go right away: the") === true);
    const tf = await voice.transcribeFull(Buffer.from("fake webm"), cfg(), "audio/webm");
    check("transcribeFull: the text and the usage OpenAI reports, as tokens", tf.text === "restart the dashboard please" && tf.tokens.audio_in === 32 && tf.tokens.text_out === 12 && tf.model === "gpt-4o-mini-transcribe", JSON.stringify(tf.tokens));
    mock.mode = "faithful";
  }

  section("realtime errors");
  mock.mode = "faithful";
  r = await expectCode(voice.speak("Hello.", cfg({ key: BAD })), "auth");
  check("a wrong key (error event after upgrade): code auth", r.ok, r.got);
  allMessages.push(r.e && r.e.message);
  mock.mode = "handshake-401";
  voice.closeAll(); // a warm socket would otherwise answer
  r = await expectCode(voice.speak("Hello.", cfg()), "auth");
  check("a 401 at the handshake: code auth", r.ok, r.got);
  check("the error message never carries a key", r.e && !/sk-proj-Z/.test(r.e.message), r.e && r.e.message);
  allMessages.push(r.e && r.e.message);
  mock.mode = "model-error";
  r = await expectCode(voice.speak("Hello.", cfg({ model: "gpt-realtime-nope" })), "model");
  check("an unknown model: code model", r.ok, r.got);
  mock.mode = "hang";
  r = await expectCode(voice.speak("Hello there.", cfg({ timeoutMs: 400 })), "timeout");
  check("no answer: code timeout", r.ok, r.got);
  mock.mode = "faithful";
  before = mock.connections;
  out = await voice.speak("After a timeout the socket is not reused.", cfg());
  check("  the socket that timed out is dropped; the next sentence opens a fresh one", mock.connections === before + 1 && out.warm === false, mock.connections - before);
  r = await expectCode(voice.speak("Hello.", { ...base, wsBase: "ws://127.0.0.1:1/v1", key: GOOD, model: "gpt-realtime-mini" }), "network");
  check("unreachable: code network", r.ok, r.got);

  section("GPT-Live protocol (gpt-live-1)");
  mock.mode = "faithful";
  out = await voice.speak("Three sessions are running and none need approval.", cfg({ model: "gpt-live-1" }));
  conn = mock.log[mock.log.length - 1];
  check("connects to /live/sessions", conn.url === "/v1/live/sessions", conn.url);
  check("no Origin header (GPT-Live answers 403 to one)", conn.headers.origin === undefined);
  const start = conn.events.find((e) => e.type === "session.start");
  check("session.start carries model, instructions, PCM 24 kHz and the voice",
    start && start.session.model === "gpt-live-1" && /word for word/.test(start.session.instructions) &&
    start.session.audio.format.rate === 24000 && start.session.audio.output.voice === "marin");
  const com = conn.events.find((e) => e.type === "session.commentary.append");
  check("the text goes in as commentary with delegation_id: null",
    com && Object.prototype.hasOwnProperty.call(com, "delegation_id") && com.delegation_id === null && com.content.startsWith("Three sessions"));
  check("silence frames are streamed so it keeps talking", conn.events.filter((e) => e.type === "session.input_audio.append").length >= 8);
  check("audio comes back trimmed to the speech, faithful",
    out.wav.length > 44 && out.wav.length < 44 + 4800 * 16 && /none need approval/.test(out.transcript), out.wav.length + " " + out.transcript);
  mock.mode = "improvise";
  r = await expectCode(voice.speak("The backup finished.", cfg({ model: "gpt-live-1", fallback: false })), "unfaithful");
  check("GPT-Live inventing a continuation is caught too", r.ok, r.got);
  out = await voice.speak("The backup finished.", cfg({ model: "gpt-live-1" }));
  check("  and falls back to text-to-speech like the realtime model", out.fallback === true);

  section("transcription");
  mock.mode = "faithful";
  const text = await voice.transcribe(Buffer.from("webm-bytes"), cfg(), "audio/webm");
  const t = mock.transcriptions[mock.transcriptions.length - 1];
  check("returns the text", text === "restart the dashboard please", text);
  check("posts the configured model and the recording with its type",
    t.model === "gpt-4o-mini-transcribe" && t.type === "audio/webm" && t.filename === "speech.webm", JSON.stringify(t));
  check("with the key as a bearer token", t.auth === "Bearer " + GOOD);
  check("with a vocabulary prompt (Joya, JOYA AI, Odoo)", /Joya/.test(t.prompt || "") && /JOYA AI/.test(t.prompt || "") && /Odoo/.test(t.prompt || ""), t.prompt);
  await voice.transcribe(Buffer.from("x"), cfg({ transcribe_model: "gpt-4o-transcribe" }), "audio/ogg;codecs=opus");
  const t2 = mock.transcriptions[mock.transcriptions.length - 1];
  check("the listening model is a setting; an odd mime falls back to webm", t2.model === "gpt-4o-transcribe" && t2.type === "audio/webm", JSON.stringify(t2));
  r = await expectCode(voice.transcribe(Buffer.from("x"), cfg({ key: BAD })), "auth");
  check("a wrong key: code auth", r.ok, r.got);
  check("OpenAI's masked key is scrubbed from the message too", r.e && !/sk-proj-\*/.test(r.e.message), r.e && r.e.message);
  allMessages.push(r.e && r.e.message);
  r = await expectCode(voice.transcribe(Buffer.from("x"), cfg({ transcribe_model: "gpt-nonexistent-transcribe" })), "model");
  check("an unknown model: code model", r.ok, r.got);
  r = await expectCode(voice.transcribe(Buffer.alloc(0), cfg()), "invalid");
  check("no audio: refused before any call", r.ok, r.got);

  section("no key");
  before = mock.connections;
  const nt = mock.transcriptions.length;
  r = await expectCode(voice.speak("Hello.", { ...base, key: null }), "no-key");
  check("speak without a key: code no-key, says where to add one", r.ok && /Add an OpenAI key in Settings/.test(r.e.message), r.got);
  r = await expectCode(voice.transcribe(Buffer.from("x"), { ...base, key: "" }), "no-key");
  check("transcribe without a key: code no-key", r.ok, r.got);
  check("and neither made a call", mock.connections === before && mock.transcriptions.length === nt);

  section("Settings > Test (a tiny live round trip)");
  mock.mode = "faithful";
  before = mock.responses;
  let c = await voice.check(cfg());
  check("speaks a line and transcribes that audio back", c.faithful === true && /Voice check/.test(c.heard) && c.seconds > 0, JSON.stringify(c));
  c = await voice.check(cfg());
  check("never answered from the cache", mock.responses === before + 2);
  mock.mode = "answer";
  c = await voice.check(cfg());
  check("Test reports an unfaithful realtime voice rather than hiding it behind the fallback", c.faithful === false, JSON.stringify(c));
  mock.mode = "faithful";
  r = await expectCode(voice.check(cfg({ key: BAD })), "auth");
  check("a wrong key: the error comes back", r.ok, r.got);

  section("the key's model list (GET /models, for GPT-4o Mini Realtime)");
  const gets = mock.modelsGets || 0;
  let ids = await voice.listModels({ ...base, key: GOOD });
  check("listModels: the ids, one GET", Array.isArray(ids) && ids.includes("gpt-realtime-mini") && !ids.includes("gpt-4o-mini-realtime-preview") && mock.modelsGets === gets + 1, JSON.stringify(ids));
  check("  so GPT-4o Mini Realtime reads as not available (known)", JSON.stringify(voice.modelAccess(ids)["gpt-4o-mini-realtime-preview"]) === '{"available":false,"use":null,"known":true}');
  mock.modelIds = ["gpt-realtime-mini", "gpt-4o-mini-realtime-preview-2024-12-17"];
  ids = await voice.listModels({ ...base, key: GOOD });
  check("  a key that gains it: available, the call uses the listed snapshot", voice.modelAccess(ids)["gpt-4o-mini-realtime-preview"].use === "gpt-4o-mini-realtime-preview-2024-12-17");
  mock.modelIds = null;
  r = await expectCode(voice.listModels({ ...base, key: BAD }), "auth");
  check("listModels with a wrong key: code auth, the key not in the message", r.ok && !String(r.e && r.e.message).includes(BAD), r.got);
  r = await expectCode(voice.listModels({ ...base, key: "" }), "no-key");
  check("listModels without a key: code no-key, no call", r.ok && mock.modelsGets === gets + 3, r.got);
  r = await expectCode(voice.listModels({ ...base, httpBase: "http://127.0.0.1:1/v1", key: GOOD }), "network");
  check("listModels, OpenAI unreachable: code network", r.ok, r.got);

  section("the key never appears in any message");
  check("no error message contains a key", allMessages.every((m) => m && !m.includes(GOOD) && !m.includes(BAD) && !/sk-proj-[A-Za-z0-9]{8}/.test(m)), allMessages.join(" | "));
  check("scrub() masks keys and bearer tokens", voice.scrub("key sk-proj-abcdefgh1234 and Bearer xyz") === "key sk-… and Bearer …");

  section("helper: key storage");
  helperTests();

  section("views: the no-key state");
  viewTests();

  voice.closeAll();
  wss.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------- helper --- */

function helperTests() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
  const driver = `
import importlib.machinery, importlib.util, io, json, os, sys, contextlib
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.VOICE_DIR = os.path.join(tmp, "joya-voice")
H.VOICE_FILE = os.path.join(H.VOICE_DIR, "openai-voice.env")
H.AUDIT_LOG = os.path.join(tmp, "audit.log")
def call(name, args=(), stdin=None):
    out = io.StringIO()
    if stdin is not None:
        sys.stdin = io.TextIOWrapper(io.BytesIO(stdin.encode()))
    with contextlib.redirect_stdout(out):
        try:
            H.COMMANDS[name](list(args))
        except SystemExit:
            pass
    return out.getvalue().strip().splitlines()[-1]
res = {}
res["status0"] = call("voice-status")
res["set_bad"] = call("voice-key-set", stdin="not-a-key")
res["set_ant"] = call("voice-key-set", stdin="sk-ant-api03-" + "A"*40)
res["set_nl"] = call("voice-key-set", stdin="sk-proj-" + "A"*30 + "\\nX=1")
res["set_ok"] = call("voice-key-set", stdin=sys.argv[3] + "\\n")
st = os.stat(H.VOICE_FILE); dst = os.stat(H.VOICE_DIR)
res["mode"] = oct(st.st_mode & 0o777); res["dirmode"] = oct(dst.st_mode & 0o777); res["uid"] = st.st_uid
res["status1"] = call("voice-status")
res["read"] = call("voice-key-read")
res["opt_bad"] = call("voice-options-set", ["gpt-4o", "marin", "gpt-4o-transcribe"])
res["opt_bad2"] = call("voice-options-set", ["gpt-realtime", "Marin;rm", "gpt-4o-mini-transcribe"])
res["opt_4o"] = call("voice-options-set", ["gpt-4o-mini-realtime-preview", "marin", "gpt-4o-transcribe"])
res["opt_4o_snap"] = call("voice-options-set", ["gpt-4o-mini-realtime-preview-2024-12-17", "marin", "gpt-4o-transcribe"])
res["opt_mini"] = call("voice-options-set", ["gpt-realtime-mini", "marin", "gpt-4o-transcribe"])
res["opt_4o_tr"] = call("voice-options-set", ["gpt-4o-mini-transcribe", "marin", "gpt-4o-transcribe"])
res["opt_ok"] = call("voice-options-set", ["gpt-live-1", "cedar", "gpt-4o-transcribe"])
res["status2"] = call("voice-status")
res["file_after_opts"] = open(H.VOICE_FILE).read()
res["clear"] = call("voice-key-clear")
res["status3"] = call("voice-status")
res["file_after_clear"] = open(H.VOICE_FILE).read()
res["audit"] = open(H.AUDIT_LOG).read()
res["no_argv_key"] = "voice-key-set" in H.COMMANDS and H.cmd_voice_key_set.__code__.co_argcount == 1
print(json.dumps(res))
`;
  const run = spawnSync("python3", ["-c", driver, path.join(ROOT, "deploy", "joya-helper"), TMP, GOOD], { encoding: "utf8" });
  let res;
  try {
    res = JSON.parse(run.stdout.trim().split("\n").pop());
  } catch (e) {
    check("the helper driver ran", false, run.stderr || run.stdout);
    return;
  }
  const J = (s) => JSON.parse(s);
  check("no key yet: not configured, defaults shown", J(res.status0).data.configured === false && J(res.status0).data.model === "gpt-realtime-mini" && J(res.status0).data.voice === "marin");
  check("refuses something that is not an OpenAI key", J(res.set_bad).ok === false);
  check("refuses an Anthropic key with a clear reason", J(res.set_ant).ok === false && /Anthropic/.test(J(res.set_ant).error));
  check("refuses a value with a newline (no second variable smuggled in)", J(res.set_nl).ok === false);
  check("stores a real-looking key", J(res.set_ok).ok === true && J(res.set_ok).data.last4 === "good");
  check("the set reply does not echo the key", !res.set_ok.includes(GOOD));
  check("file is 0600, directory 0700, owned by root", res.mode === "0o600" && res.dirmode === "0o700" && res.uid === 0, res.mode + " " + res.dirmode + " " + res.uid);
  const s1 = J(res.status1).data;
  check("status: configured, last four only", s1.configured === true && s1.last4 === "good" && s1.length === GOOD.length);
  check("status never contains the key", !res.status1.includes(GOOD) && !res.status1.includes(GOOD.slice(0, 20)));
  check("key-read returns it (for the panel's own process)", J(res.read).data.key === GOOD);
  check("options: refuses a non-realtime model", J(res.opt_bad).ok === false);
  check("options: refuses a malformed voice", J(res.opt_bad2).ok === false);
  check("options: accepts the re-added voice models (gpt-realtime-mini, gpt-4o-mini-realtime-preview and its dated snapshot), still refuses a transcribe model there",
    J(res.opt_4o).ok === true && J(res.opt_4o_snap).ok === true && J(res.opt_mini).ok === true && J(res.opt_4o_tr).ok === false);
  check("options: model, voice and listening model saved", J(res.opt_ok).ok && J(res.status2).data.model === "gpt-live-1" && J(res.status2).data.voice === "cedar" && J(res.status2).data.transcribe_model === "gpt-4o-transcribe");
  check("saving options keeps the key", res.file_after_opts.includes("OPENAI_API_KEY=" + GOOD));
  check("remove: not configured, key gone from the file, options kept",
    J(res.status3).data.configured === false && !res.file_after_clear.includes(GOOD) && res.file_after_clear.includes("OPENAI_VOICE_MODEL=gpt-live-1"));
  check("audited: set, options and clear, with the last four only",
    /voice-key-set/.test(res.audit) && /voice-options-set/.test(res.audit) && /voice-key-clear/.test(res.audit) && !res.audit.includes(GOOD) && /"last4": "good"/.test(res.audit));
  check("the key is taken on stdin, never argv", res.no_argv_key === true);
  fs.rmSync(TMP, { recursive: true, force: true });
}

/* -------------------------------------------------------------- views --- */

function viewTests() {
  const user = { name: "Tester", username: "tester", perm: rbac.actor({ permissions: ["*"] }) };
  const off = views.page({ csrf: "c", user, voice: { configured: false, manage: true, voice: "marin", on: true, use: true, live: false } });
  check("Command Center without a key (voice on): a manager is pointed to Settings ▸ Voice (the struck-through waveform says it; a click links there)", /id="cc-mic-off"[^>]*title="Voice is off: add an OpenAI token in JOYA AI Settings ▸ Voice"/.test(off));
  // v3: the big "Talk to JOYA" card left the rail; the composer mic is the one control -- and without voice it is not there.
  check("  no mic, voice-ready flag off, no big mic card", !/id="cc-c-mic"/.test(off) && /data-voice-ready=""/.test(off) && !/id="cc-mic-big"/.test(off));
  const offNoManage = views.page({ csrf: "c", user, voice: { configured: false, manage: false, on: true, use: true, live: false } });
  check("  someone who cannot manage it gets no link and no pointer to Settings", !/href="\/joya-ai\/settings\/voice"/.test(offNoManage) && /id="cc-mic-off"[^>]*title="Voice is off: an administrator can switch it on"/.test(offNoManage) && !/data-voice-off="[^"]*Settings/.test(offNoManage));
  const on = views.page({ csrf: "c", user, voice: { configured: true, manage: true, voice: "marin", model: "gpt-realtime-2.1-mini", on: true, use: true, live: true } });
  check("with a key and voice on: the mic starts a live call, OpenAI and the voice named, no setup prompt",
    /id="cc-c-mic"[^>]*title="Start a live conversation"/.test(on) && /data-voice-ready="1"/.test(on) && />OpenAI</.test(on) && />marin</.test(on) && !/cc-voice-off/.test(on) &&
    !/id="cc-speak-toggle"/.test(on) && /id="cc-reply-read"/.test(on) && !/id="cc-mic-off"/.test(on));
  check("no Whisper or Piper left on the page", !/Whisper|Piper/i.test(on + off));

  check("the classic chat's view is gone (removed 2026-10-25)", !fs.existsSync(path.join(ROOT, "lib", "views-console.js")));

  const SV = require(path.join(ROOT, "lib", "views-settings-voice.js"));
  const sv = (o) => SV.body(Object.assign({ csrf: "c", on: true, status: { configured: true }, model: "gpt-realtime-2.1-mini", models: voice.VOICE_MODELS, voice: "marin", voices: voice.voicesFor("gpt-realtime-2.1-mini"), meta: voice.VOICE_META, liveAudio: {}, usage: null }, o || {}));
  const page = sv();
  check("Settings ▸ Voice: the key is masked (not even its last four), with Replace, Remove and Test", /class="kv-mask"/.test(page) && /class="state ok"[\s\S]{0,200}?Set</.test(page) && !/good/.test(page) && /data-modal-open="m-voice-token"/.test(page) && /id="voice-remove"/.test(page) && /id="voice-test"/.test(page));
  check("Settings ▸ Voice: the key field is a write-only password input, empty, in a dialog", /<section class="cc-modal os narrow" id="m-voice-token"[^>]* hidden>/.test(page) && /<input name="value" type="password"[^>]*required/.test(page) && !/value="sk-/.test(page));
  const modelSelect = (page.match(/<select name="model"[\s\S]*?<\/select>/) || [""])[0];
  check("Settings ▸ Voice: four voice models (2.1 mini selected; GPT-Live listed, not checked yet), no transcription selector (2026-10-30), the model's ten voice cards, current one selected",
    /<option value="gpt-realtime-2\.1-mini" data-hint="[^"]*" selected>GPT Realtime 2\.1 mini \(current\)</.test(modelSelect) && (modelSelect.match(/<option /g) || []).length === 4 && /<option value="gpt-live-1" data-hint="Not checked[^"]*" disabled>GPT-Live \+ JOYA AI \(not checked yet\)</.test(modelSelect) && !/name="transcribe_model"/.test(page) && !/<select name="transcriber"/.test(page) && !/transcribe/.test(page.replace(/gpt-4o-transcribe/g, "")) && /<input type="radio" name="voice" value="marin" checked>/.test(page) && (page.match(/name="voice" value=/g) || []).length === 10);
  check("the voice models: 2.1 mini, gpt-realtime-mini, GPT-4o Mini Realtime and GPT-Live (gated); only 2.1 mini reads aloud, anything else reads with it; listening is gpt-4o-transcribe",
    voice.VOICE_MODELS.map((m) => m.id).join() === "gpt-realtime-2.1-mini,gpt-realtime-mini,gpt-4o-mini-realtime-preview,gpt-live-1" && voice.VOICE_MODEL_DEFAULT === "gpt-realtime-2.1-mini" && voice.VOICE_MODELS.filter((m) => m.gated).map((m) => m.id).join() === "gpt-4o-mini-realtime-preview,gpt-live-1" && voice.READER_MODELS.join() === "gpt-realtime-2.1-mini" && voice.readerModelFor("gpt-realtime-2.1-mini") === "gpt-realtime-2.1-mini" && voice.readerModelFor("gpt-realtime-mini") === "gpt-realtime-2.1-mini" && voice.readerModelFor("gpt-4o-mini-realtime-preview") === "gpt-realtime-2.1-mini" && voice.readerModelFor("gpt-live-1") === "gpt-realtime-2.1-mini" && voice.listenModelFor("gpt-realtime-2.1-mini") === "gpt-4o-transcribe" && voice.DEFAULTS.model === "gpt-realtime-2.1-mini" && voice.DEFAULTS.transcribe_model === "gpt-4o-transcribe" && voice.TRANSCRIBE_MODELS === undefined);
  check("the options carry the facts: 18/18 + Arabic OK; 14/18, Arabic in English, retires 20 Jan 2027, read by 2.1 mini; 4o: read by 2.1 mini",
    /18\/18/.test(voice.VOICE_MODELS[0].hint) && /Arabic in Arabic/.test(voice.VOICE_MODELS[0].hint) && /14\/18/.test(voice.VOICE_MODELS[1].hint) && /Arabic in English/.test(voice.VOICE_MODELS[1].hint) && /20 Jan 2027/.test(voice.VOICE_MODELS[1].hint) && /read aloud by 2\.1 mini/.test(voice.VOICE_MODELS[1].hint) && /read aloud by 2\.1 mini/.test(voice.VOICE_MODELS[2].hint) &&
    /<option value="gpt-realtime-mini" data-hint="[^"]*14\/18[^"]*20 Jan 2027[^"]*">GPT Realtime mini</.test(modelSelect) && /id="voice-retire-note">GPT Realtime mini retires on 20 January 2027\./.test(page) && /id="voice-model-hint">The default\./.test(page));
  check("GPT-4o Mini Realtime, access not known: listed, disabled, 'not checked on this OpenAI key yet'",
    /<option value="gpt-4o-mini-realtime-preview" data-hint="Not checked[^"]*" disabled>GPT-4o Mini Realtime \(not checked yet\)</.test(modelSelect));
  const noAccess = sv({ access: voice.modelAccess(["gpt-realtime-mini", "gpt-realtime-2.1-mini"]) });
  const noSel = (noAccess.match(/<select name="model"[\s\S]*?<\/select>/) || [""])[0];
  check("GPT-4o Mini Realtime, not in the key's model list: disabled, 'not available on this OpenAI key'; the other two enabled",
    /<option value="gpt-4o-mini-realtime-preview" data-hint="This OpenAI key cannot use it[^"]*" disabled>GPT-4o Mini Realtime \(not on this key\)</.test(noSel) && (noSel.match(/ disabled>/g) || []).length === 2 && /<option value="gpt-live-1"[^>]* disabled>GPT-Live \+ JOYA AI \(not on this key\)</.test(noSel));
  const withAccess = sv({ access: voice.modelAccess(["gpt-4o-mini-realtime-preview-2024-12-17", "gpt-live-1"]) });
  const wSel = (withAccess.match(/<select name="model"[\s\S]*?<\/select>/) || [""])[0];
  check("GPT-4o Mini Realtime, listed (a dated snapshot): offered normally", /<option value="gpt-4o-mini-realtime-preview" data-hint="A preview model[^"]*">GPT-4o Mini Realtime</.test(wSel) && !/ disabled>/.test(wSel));
  const cur4o = sv({ model: "gpt-4o-mini-realtime-preview", access: voice.modelAccess(["gpt-4o-mini-realtime-preview"]) });
  check("GPT-4o Mini Realtime current: selected, its hint under the selector", /<option value="gpt-4o-mini-realtime-preview" data-hint="[^"]*" selected>GPT-4o Mini Realtime \(current\)</.test(cur4o) && /id="voice-model-hint">A preview model\./.test(cur4o));
  const acc = (ids) => JSON.stringify(voice.modelAccess(ids)["gpt-4o-mini-realtime-preview"]);
  check("modelAccess: unknown -> not available (not known); listed -> itself; only a dated snapshot -> the newest one; lookalikes ignored; ungated always",
    acc(null) === '{"available":false,"use":null,"known":false}' && acc([]) === '{"available":false,"use":null,"known":true}' && acc(["gpt-4o-mini-realtime-preview"]) === '{"available":true,"use":"gpt-4o-mini-realtime-preview","known":true}' &&
    acc(["gpt-4o-mini-realtime-preview-2024-12-17", "gpt-4o-mini-realtime-preview-2025-06-03"]) === '{"available":true,"use":"gpt-4o-mini-realtime-preview-2025-06-03","known":true}' && acc(["gpt-4o-mini-realtime-preview-x", "gpt-4o-mini-realtime-previewz-2024-12-17", "gpt-4o-realtime-preview"]) === '{"available":false,"use":null,"known":true}' &&
    voice.modelAccess(null)["gpt-realtime-mini"].available === true && voice.modelAccess([])["gpt-realtime-2.1-mini"].available === true);
  check("Settings ▸ Voice: each voice card names its gender", /Marin<\/b><span class="g"[^>]*><i aria-hidden="true">♀<\/i>Female/.test(page) && /Alloy<\/b><span class="g"[^>]*><i aria-hidden="true">◌<\/i>Neutral/.test(page) && /Cedar<\/b><span class="g"[^>]*><i aria-hidden="true">♂<\/i>Male/.test(page));
  const pageOff = sv({ status: { configured: false } });
  check("Settings ▸ Voice without a key: Add key, no Remove, Test disabled", /Add key/.test(pageOff) && !/id="voice-remove"/.test(pageOff) && /id="voice-test" disabled/.test(pageOff));
  const failed = sv({ test: { ok: false, text: "OpenAI refused the key <x>" } });
  check("Settings ▸ Voice: a failed test is shown, escaped", /Test failed/.test(failed) && /&lt;x&gt;/.test(failed));

  check("rbac: voice.manage exists and is in no stock role",
    rbac.PERMISSION_SET.has("voice.manage") && rbac.SYSTEM_ROLES.filter((r) => r.name !== "administrator").every((r) => !r.permissions.includes("voice.manage")));
  check("rbac: the administrator holds it", rbac.actor({ permissions: ["*"] }).can("voice.manage"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
