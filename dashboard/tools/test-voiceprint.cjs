#!/usr/bin/env node
"use strict";
/**
 * The voiceprint (lib/voiceprint.js, lib/voiceprint-routes.js, the relay's
 * gate in lib/voice-live.js, Settings ▸ Voice ▸ Voiceprint, the enrolment page).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-voiceprint.cjs
 *
 * A FAKE joya-voiceprint on a Unix socket here: it reads who is speaking from
 * the audio's amplitude (1000 = the administrator, 2000 = someone else,
 * 2500 = unsure, 3000 = JOYA AI's TTS voice, silence = too short) and answers
 * the matching embedding; it can be slowed, broken or stopped. A fake helper
 * seals with AES-256-GCM in the test. The relay runs against a mock OpenAI
 * realtime server (as tools/test-voice-live.cjs).
 *
 *   1. the library: verdicts and thresholds, fail-open (down, slow, nonsense),
 *      enrolment (sums only, sealed on disk, reopened by a new process), JOYA
 *      AI's voice learned for the echo rule, the ledger and the 7-day stats;
 *   2. the relay: OFF = no service call at all and calls as before; SHADOW =
 *      every turn checked and logged, none blocked; the GATE = yours answered,
 *      another voice ignored (page note, never spoken, its "yes" confirms
 *      nothing), unsure not answered and never spoken about, JOYA AI's echo dropped; switching on, off
 *      and gating mid-call (the next turn follows); fail-open with the gate on;
 *      hold-to-talk presses;
 *   3. the routes on a scratch copy of server.js: the switch (audited),
 *      the gate needs a voiceprint, enrolment from the trial's recordings and
 *      on the enrolment page, delete, delete everything (voiceprint, key,
 *      trial clips, results, ledger), permissions and CSRF, the service-down
 *      warning;
 *   4. the pages in Chromium, 1440 and 390 px, light and dark: no horizontal
 *      scroll, the switch works, the enrolment page records through the real
 *      worklet with a fake microphone, zero page errors and CSP violations.
 *   5. (when the real model and the trial's recordings are on this box) the
 *      real service on a temporary socket, the administrator's real voice
 *      against real other voices and JOYA AI's real TTS voice.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "lib", "db.js"));
const vpLib = require(path.join(ROOT, "lib", "voiceprint.js"));
const live = require(path.join(ROOT, "lib", "voice-live.js"));
const desk = require(path.join(ROOT, "lib", "voice-shared.js"));
const trialLib = require(path.join(ROOT, "lib", "voiceprint-trial.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
}

/* ------------------------------------------------- the fake service ---- */

const DIM = 64;
const e = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const U = e(0); // the administrator (AbdElMoniem)
const O = e(1); // someone unknown
const T = e(2); // JOYA AI's TTS voice
const Z = e(3); // another stored person (Zaghloul)
const TIE = vpLib.unit(U.map((x, k) => x + Z[k])); // 0.707 to both: too close to name
const M = vpLib.unit(U.map((x, k) => 0.25 * x + 0.968 * O[k])); // unsure: 0.25 against U
const OVER = vpLib.unit(T.map((x, k) => 0.8 * x + 0.1 * U[k])); // JOYA AI's voice leaking back: close to T, ~0.12 to U

function speakerOf(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  if (peak < 300) return null;
  if (peak < 1100) return U;
  if (peak < 1350) return Z;
  if (peak < 1600) return TIE;
  if (peak < 2250) return O;
  if (peak < 2750) return M;
  if (peak < 3500) return T;
  return OVER;
}
const svc = { calls: [], mode: "ok", delay: 0 };
function startFakeService(sock) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(parts);
      const who0 = speakerOf(body);
      svc.calls.push({ path: req.url, bytes: body.length, who: who0 === U ? "user" : who0 === Z ? "zaghloul" : who0 === O ? "other" : who0 === M ? "unsure" : who0 ? "tts" : "silence" });
      if (svc.delay) await sleep(svc.delay);
      if (svc.mode === "broken") return res.writeHead(500, { "Content-Type": "application/json" }), res.end(JSON.stringify({ ok: false, error: "boom" }));
      if (svc.mode === "nonsense") return res.writeHead(200), res.end("not json");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/health")) return res.end(JSON.stringify({ ok: true, model: "fake.onnx", dim: DIM, threads: 1, sha256: "0".repeat(64) }));
      const who = speakerOf(body);
      if (req.url.startsWith("/enrol")) {
        if (!who) return res.end(JSON.stringify({ ok: false, error: "not enough speech" }));
        return res.end(JSON.stringify({ ok: true, embedding: who.map((x) => x * 3), windows: 3, speech_ms: Math.round(body.length / (req.url.includes("24000") ? 48 : 32)), ms: 1 }));
      }
      const ms = Math.round(body.length / 48);
      res.end(JSON.stringify({ ok: true, embedding: who, too_short: !who, speech_ms: who ? ms : 0, used_ms: who ? Math.min(ms, 1200) : 0, ms: 2 }));
    });
  });
  return new Promise((r) => server.listen(sock, () => r(server)));
}

/* --------------------------------------------- a fake helper (seal) ---- */

function fakePriv(dir) {
  const kf = path.join(dir, "key");
  const calls = { seal: 0, open: 0, forget: [] };
  return {
    calls,
    voiceprintSeal: async (b64) => {
      calls.seal++;
      if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32));
      const n = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", fs.readFileSync(kf), n);
      const ct = Buffer.concat([c.update(Buffer.from(b64, "base64")), c.final()]);
      return { sealed: Buffer.concat([n, ct, c.getAuthTag()]).toString("base64") };
    },
    voiceprintOpen: async (b64) => {
      calls.open++;
      const b = Buffer.from(b64, "base64");
      const d = crypto.createDecipheriv("aes-256-gcm", fs.readFileSync(kf), b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return { plain: Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("base64") };
    },
    voiceprintForget: async (keep) => {
      calls.forget.push(!!keep);
      if (!keep && fs.existsSync(kf)) fs.unlinkSync(kf);
      return { key_deleted: !keep, results_deleted: 2 };
    },
  };
}

function tone(amp, ms, rate) {
  const n = Math.round(((rate || 24000) * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 4 < 2 ? amp : -amp, i * 2);
  return b;
}

/* ------------------------------------------------ 1. the library ------- */

function decideTests() {
  section("1a. who is speaking: decide() (1-vs-N)");
  const th = { ...vpLib.DEFAULTS };
  const D = (scores, o) => vpLib.decide(scores, { speechMs: 1500, overVoice: false, tts: null, current: null, ...(o || {}) }, th);
  const A = (x) => ({ id: "pA", score: x });
  const B = (x) => ({ id: "pB", score: x });
  check("one clear best, ahead by the margin: named", D([A(0.6), B(0.1)]).verdict === "accept" && D([A(0.6), B(0.1)]).id === "pA" && D([A(0.1), B(0.5)]).id === "pB");
  check("two stored people too close (both above accept): not sure who", D([A(0.5), B(0.47)]).verdict === "uncertain" && D([A(0.5), B(0.47)]).id === null);
  check("  unless one of them is the call's speaker: then them", D([A(0.5), B(0.47)], { current: "pB" }).verdict === "sticky" && D([A(0.5), B(0.47)], { current: "pB" }).id === "pB");
  check("everyone below reject: an unknown voice", D([A(0.1), B(0.15)]).verdict === "reject");
  check("in between, nobody yet in the call: not sure", D([A(0.27), B(0.05)]).verdict === "uncertain");
  check("in between, the call's speaker fits: them (per-speaker leniency)", D([A(0.27), B(0.05)], { current: "pA" }).verdict === "sticky");
  check("  but not when someone else is clearly ahead (a change of speaker)", D([A(0.21), B(0.29)], { current: "pA" }).verdict === "uncertain");
  check("  nor under stickyMin (Strictness)", vpLib.decide([A(0.22), B(0.05)], { speechMs: 1500, current: "pA" }, { ...th, stickyMin: 0.25 }).verdict === "uncertain");
  check("  nor heard over JOYA AI's voice", D([A(0.27), B(0.05)], { current: "pA", overVoice: true }).verdict === "uncertain");
  check("a clear other stored person switches the speaker", D([A(0.1), B(0.6)], { current: "pA" }).verdict === "accept" && D([A(0.1), B(0.6)], { current: "pA" }).id === "pB");
  check("short (< 0.8 s): the call's speaker if they fit, else unverified (unnamed); clearly unknown still reject", D([A(0.25)], { speechMs: 500, current: "pA" }).verdict === "sticky" && D([A(0.25)], { speechMs: 500 }).verdict === "unverified" && D([A(0.1)], { speechMs: 500 }).verdict === "reject");
  check("JOYA AI's own voice over its playback: echo", D([A(0.3)], { overVoice: true, tts: 0.8 }).verdict === "echo" && D([A(0.3)], { overVoice: false, tts: 0.8 }).verdict !== "echo");
  check("nothing stored: none", D([]).verdict === "none");
  check("names: Latin display names, Arabic spoken names", vpLib.cleanName("AbdElMoniem").ok && vpLib.cleanName("Zaghloul").ok && !vpLib.cleanName("").ok && !vpLib.cleanName("<b>x</b>").ok && !vpLib.cleanName("زغلول").ok && vpLib.cleanSpoken("زغلول").ok && vpLib.cleanSpoken("عبد المنعم").ok && !vpLib.cleanSpoken("a\u0000b").ok);
}

async function library(sock) {
  section("1b. the library: stored voiceprints by name");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-lib-"));
  const priv = fakePriv(dir);
  const logs = [];
  const users = { 1: { id: 1, username: "amaraghy", display_name: "amaraghy" }, 7: { id: 7, username: "guest7", display_name: "Guest Seven" } };
  // A print from before names: DATA_DIR/voiceprint/1.json, sealed (the migration's input).
  fs.mkdirSync(path.join(dir, "voiceprint"), { recursive: true, mode: 0o700 });
  const oldSealed = (await priv.voiceprintSeal(Buffer.from(JSON.stringify({ v: 1, mics: { laptop: { sum: U.map((x) => x * 19), windows: 19 } } })).toString("base64"))).sealed;
  fs.writeFileSync(path.join(dir, "voiceprint", "1.json"), JSON.stringify({ v: 1, sealed: oldSealed, created_at: "2026-10-07T19:31:55.257Z", mics: { laptop: { windows: 19, speech_s: 50.2, source: "trial" } } }), { mode: 0o600 });
  const mk = () => vpLib.createVoiceprint({ db, priv, dataDir: dir, socketPath: sock, log: (m) => logs.push(m), userById: (id) => users[id] || null });
  const vp = mk();
  const ps = vp.people();
  check("migration: the old print becomes “AbdElMoniem” («عبد المنعم»), linked to amaraghy, may give commands, its microphones kept", ps.length === 1 && ps[0].name === "AbdElMoniem" && ps[0].spoken === "عبد المنعم" && ps[0].user_id === 1 && ps[0].may_command === true && ps[0].mics.laptop.speech_s === 50.2 && ps[0].enrolled, JSON.stringify(ps));
  check("  the old file is gone; people.json is 0600 and holds the sealed blob, no numbers in clear", !fs.existsSync(path.join(dir, "voiceprint", "1.json")) && (fs.statSync(path.join(dir, "voiceprint", "people.json")).mode & 0o777) === 0o600 && !/"sum"/.test(fs.readFileSync(path.join(dir, "voiceprint", "people.json"), "utf8")));
  await vp.openAll();
  check("  and it opens through the helper", vp.hasPrints() && priv.calls.open === 1);
  const A = ps[0];
  const me = { id: 1, username: "amaraghy" };
  check("  personForUser finds it", vp.personForUser(me).id === A.id);

  const bad = (fn) => {
    try {
      fn();
      return null;
    } catch (x) {
      return x;
    }
  };
  check("add: a bad name, a duplicate and a second print for the same user are refused", /Latin letters/.test((bad(() => vp.addPerson({ name: "زغلول" })) || {}).message) && /already a voiceprint called/.test((bad(() => vp.addPerson({ name: "abdelmoniem" })) || {}).message) && /already has a voiceprint/.test((bad(() => vp.addPerson({ name: "Other", user_id: 1 })) || {}).message));
  const Zp = vp.addPerson({ name: "Zaghloul", spoken: "زغلول" });
  check("add Zaghloul: not linked, may NOT give commands by default", Zp.name === "Zaghloul" && Zp.spoken === "زغلول" && Zp.user_id === null && Zp.may_command === false && !Zp.enrolled);
  for (const id of ["e1", "e2", "e3"]) await vp.enrolClip(Zp.id, "laptop", id, tone(1250, 12000, 16000), 16000);
  const zs = await vp.enrolSave(Zp.id, "laptop");
  check("enrol Zaghloul (36 s)", zs.name === "Zaghloul" && vp.person(Zp.id).enrolled);

  const c1 = await vp.check(tone(1000, 1500), {});
  const c2 = await vp.check(tone(1250, 1500), {});
  const c3 = await vp.check(tone(1500, 1500), {});
  const c4 = await vp.check(tone(2000, 1500), {});
  const c5 = await vp.check(tone(2500, 1500), { current: { id: A.id, at: Date.now() } });
  check("1-vs-N: AbdElMoniem and Zaghloul named; too close: not sure; unknown: reject; doubtful in AbdElMoniem's call: him", c1.verdict === "accept" && c1.speaker.name === "AbdElMoniem" && c2.verdict === "accept" && c2.speaker.name === "Zaghloul" && c2.speaker.may_command === false && c3.verdict === "uncertain" && !c3.speaker && c4.verdict === "reject" && c5.verdict === "sticky" && c5.speaker.name === "AbdElMoniem", JSON.stringify([c1, c2, c3, c4, c5].map((x) => [x.verdict, x.speaker && x.speaker.name])));
  check("  the service was asked for the turn's first 3 s at 24 kHz", svc.calls.some((x) => /\/embed\?rate=24000&first=3/.test(x.path)));
  check("  last heard is kept", !!vp.person(A.id).last_heard);

  vp.updatePerson(Zp.id, { may_command: true, spoken: "زغلول باشا" });
  check("update: may give commands, spoken name", vp.person(Zp.id).may_command === true && vp.person(Zp.id).spoken === "زغلول باشا" && (await vp.check(tone(1250, 1500), {})).speaker.may_command === true);
  check("  rename to a taken name refused", /already a voiceprint called/.test((bad(() => vp.updatePerson(Zp.id, { name: "AbdElMoniem" })) || {}).message));

  const vp2 = mk();
  await vp2.openAll();
  check("a new process opens every stored print", vp2.hasPrints() && vp2.people().length === 2 && (await vp2.check(tone(1250, 1500), {})).speaker.name === "Zaghloul");

  check("JOYA AI's voice: learned from what was played, then not again within a minute", (await vp2.learnTts("marin", tone(3000, 2000))) === true && (await vp2.learnTts("marin", tone(3000, 2000))) === false && !!vp2.ttsPrint("marin"));
  const ec = await vp2.check(tone(4000, 1500), { overVoice: true, voice: "marin" });
  check("echo over the voice", ec.verdict === "echo" && ec.tts_score > 0.9, JSON.stringify(ec));

  svc.mode = "broken";
  const f1 = await vp2.check(tone(1000, 1500), {});
  svc.mode = "ok";
  svc.delay = 600;
  const t0 = Date.now();
  const f3 = await vp2.check(tone(1000, 1500), {});
  const took = Date.now() - t0;
  svc.delay = 0;
  check("fail open: an error or a slow service is 'error' (never thrown), given up at 400 ms, shown in the status", f1.verdict === "error" && f3.verdict === "error" && took < 550 && vp2.status(me).service.ok === false, JSON.stringify([f1, f3, took]));
  check("  and a good answer clears it", (await vp2.check(tone(1000, 1500), {})).verdict === "accept" && vp2.status(me).service.error === null);

  db.voiceprintChecksDeleteAll();
  for (const [v, sid, sn] of [["accept", A.id, "AbdElMoniem"], ["accept", A.id, "AbdElMoniem"], ["sticky", Zp.id, "Zaghloul"], ["reject", null, null], ["uncertain", null, null]]) vp2.ledger({ actor: "vpuser", call_id: "lvx", turn: 1, mode: "vad", verdict: v, score: 0.5, ms: 20, acted: sn === "Zaghloul" ? "shadow, talk only" : "shadow", speaker_id: sid, speaker: sn });
  const st = vp2.stats(7);
  check("7 days per person: turns, talk only; unknown and unsure", st.checked === 5 && st.people.map((x) => x.name + ":" + x.turns).join() === "AbdElMoniem:2,Zaghloul:1" && st.people[1].talk_only === 1 && st.unknown === 1 && st.unsure === 1, JSON.stringify(st.people));

  await vp2.enrolClip(Zp.id, "headset", "e1", tone(1250, 40000, 16000), 16000);
  await vp2.enrolSave(Zp.id, "headset");
  check("a second microphone for Zaghloul; removing it keeps the first", Object.keys(vp2.person(Zp.id).mics).join() === "laptop,headset" && (await vp2.removeMic(Zp.id, "headset")) && Object.keys(vp2.person(Zp.id).mics).join() === "laptop");
  await vp2.removePerson(Zp.id);
  check("delete one person: only theirs", vp2.people().map((x) => x.name).join() === "AbdElMoniem" && (await vp2.check(tone(1250, 1500), {})).verdict !== "accept");
  for (let i = 0; i < 9; i++) vp2.addPerson({ name: "Guest " + i });
  check("at most 10 stored voiceprints", /At most 10/.test((bad(() => vp2.addPerson({ name: "Eleven" })) || {}).message));
  const fa = await vp2.forgetAll();
  check("delete everything: every voiceprint, the ledger, JOYA AI's voice print, the key", fa.people === 10 && fa.ledger_rows === 5 && vp2.people().length === 0 && !vp2.hasPrints() && !fs.existsSync(path.join(dir, "voiceprint", "tts.json")) && priv.calls.forget[priv.calls.forget.length - 1] === false, JSON.stringify(fa));
  check("nothing about a voice in the log lines", logs.every((l) => !/\[|\d\.\d{4}/.test(l)), logs.join("\n"));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------- 2. the relay ------------ */

const KEY = "sk-proj-" + "V".repeat(40) + "vpvp";
const mock = { sessions: [] };
const mockServer = http.createServer((q, s) => (s.writeHead(404), s.end()));
const mockWss = new WebSocketServer({ noServer: true });
mockServer.on("upgrade", (req, sock, head) => {
  mockWss.handleUpgrade(req, sock, head, (ws) => {
    const s = { ws, events: [], session: null };
    s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
    s.of = (type) => s.events.filter((x) => x.type === type);
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "input_audio_buffer.append") return;
      s.events.push(ev);
      if (ev.type === "session.update") {
        s.session = { ...(s.session || {}), ...ev.session };
        s.push({ type: "session.updated", session: s.session });
      }
    });
    mock.sessions.push(s);
  });
});
let WS_BASE;

function relayCall(vp, user, extra) {
  const x = extra || {};
  const client = { json: [], audio: [] };
  const logs = [];
  const spoke = [];
  const heardConfirm = [];
  const c = new live.LiveCall({
    cfg: { key: KEY, voice: "marin", model: "gpt-realtime-mini", transcribe_model: "gpt-4o-mini-transcribe", wsBase: WS_BASE },
    actor: user.username,
    ops: desk.voiceOps(() => Promise.resolve({}), user.username),
    client: { json: (o) => client.json.push(o), audio: (seg, buf) => client.audio.push({ seg, bytes: buf.length }), close: () => {} },
    persona: () => ({}),
    speak: async (text, cfg, sink) => {
      spoke.push(text);
      sink.start({ engine: "fake" });
      sink.audio(Buffer.alloc(4800));
      return { billing: [], lateBilling: Promise.resolve([]) };
    },
    transcribe: async () => ({ text: "", model: "gpt-4o-mini-transcribe", tokens: null }),
    summarise: async () => ({ tokens: null }),
    record: () => 0,
    isStop: (t) => VoiceStop.heard(t),
    isUndo: (t) => VoiceStop.undo(t),
    isYesNo: (t) => VoiceStop.yes(t) || VoiceStop.no(t),
    confirmPending: x.confirm ? () => true : undefined,
    confirmHeard: x.confirm ? (text) => (heardConfirm.push(text), { confirmed: { id: "cf1" } }) : undefined,
    log: (m) => logs.push(m),
    voiceprint: vp
      ? { enabled: () => vp.enabled(), gate: () => vp.gate(), hasPrints: () => vp.hasPrints(), check: (pcm, o) => vp.check(pcm, o), record: (row) => vp.ledger({ ...row, actor: user.username }), learnTts: (v, pcm) => vp.learnTts(v, pcm) }
      : null,
    opts: { pollMs: 20, ...(x.opts || {}) },
  });
  return { c, client, logs, spoke, heardConfirm };
}
async function turn(s, c, amp, text, o) {
  const item = "item_" + Math.random().toString(36).slice(2, 8);
  const ms = (o && o.ms) || 1500;
  c.audioIn(tone(0, 400)); // a pause between turns
  const at = c.inputMs;
  c.audioIn(tone(amp, ms));
  s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: at, item_id: item });
  s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
  s.push({ type: "input_audio_buffer.committed", item_id: item });
  s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text });
  await sleep(120);
  return item;
}
const created = (s) => s.of("response.create").length;
const deleted = (s, item) => s.of("conversation.item.delete").some((x) => x.item_id === item);

async function relay(sock) {
  section("2. the relay (lib/voice-live.js)");
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + mockServer.address().port + "/v1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-relay-"));
  const priv = fakePriv(dir);
  const vp = vpLib.createVoiceprint({ db, priv, dataDir: dir, socketPath: sock, log: () => {}, userById: () => null });
  const me = { id: 51, username: "relayuser" };
  const A = vp.addPerson({ name: "AbdElMoniem", spoken: "عبد المنعم", user_id: 51, may_command: true });
  for (const id of ["e1", "e2", "e3", "e4"]) await vp.enrolClip(A.id, "laptop", id, tone(1000, 10000, 16000), 16000);
  await vp.enrolSave(A.id, "laptop");
  const Zp = vp.addPerson({ name: "Zaghloul", spoken: "زغلول" });
  for (const id of ["e1", "e2", "e3", "e4"]) await vp.enrolClip(Zp.id, "laptop", id, tone(1250, 10000, 16000), 16000);
  await vp.enrolSave(Zp.id, "laptop");
  db.voiceprintChecksDelete("relayuser");

  // OFF
  vp.setEnabled(false, "test");
  {
    const { c, client } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const before = svc.calls.length;
    await turn(s, c, 2000, "what is the disk usage?");
    check("OFF: the service is never called", svc.calls.length === before);
    check("  and the page gets no voiceprint event (the pill shows nothing)", !client.json.some((m) => m.type === "voiceprint"));
    check("  and the turn is answered as always", created(s) === 1 && client.json.some((m) => m.type === "caption" && m.who === "you"));
    check("  nothing in the ledger", db.voiceprintChecksSince(0, "relayuser").length === 0);
    c.close("test");
  }

  // SHADOW
  vp.setEnabled(true, "test");
  {
    const { c, client, logs } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "what is the disk usage?");
    await turn(s, c, 2000, "turn off the lights");
    await turn(s, c, 2500, "maybe me");
    await until(() => db.voiceprintChecksSince(0, "relayuser").length >= 3, 1500);
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check("SHADOW: every turn checked and logged (the unsure one after a recognised turn is the call's voice)", rows.length === 3 && rows.map((r) => r.verdict).join() === "accept,reject,sticky" && rows.every((r) => r.acted === "shadow" && !r.gated), JSON.stringify(rows.map((r) => [r.verdict, r.acted])));
    check("  nothing blocked: all three answered", created(s) === 3);
    const ev = client.json.filter((m) => m.type === "voiceprint");
    check("  the page's pill is told each verdict, as 'would' (gated false), never a score", ev.map((m) => m.kind).join() === "known,other,known" && ev[0].name === "AbdElMoniem" && ev.every((m) => m.gated === false && !("score" in m) && !("tts_score" in m)), JSON.stringify(ev));
    check("  the log names the verdict and score per turn, nothing else of the voice", logs.some((l) => /turn \d+ voiceprint: accept, AbdElMoniem \(new speaker\), 1\.000/.test(l)) && logs.some((l) => /voiceprint: reject, unknown voice, 0\.000.*\(shadow\)/.test(l)), logs.filter((l) => /voiceprint/.test(l)).join("\n"));
    c.close("test");
  }

  // GATE
  db.voiceprintChecksDelete("relayuser");
  vp.setGate(true, "test");
  {
    const { c, client, spoke } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "what is the disk usage?");
    check("GATE: your voice is answered", created(s) === 1 && client.json.filter((m) => m.type === "caption" && m.who === "you").length === 1);
    const other = await turn(s, c, 2000, "turn off the lights");
    check("  another voice: not answered, forgotten upstream, its words never shown", created(s) === 1 && deleted(s, other) && client.json.filter((m) => m.type === "caption" && m.who === "you").length === 1);
    check("  the page is told (shown on the pill, never spoken), gated", client.json.some((m) => m.type === "voiceprint" && m.kind === "other" && m.gated === true) && !spoke.some((t) => /not your voice/i.test(t)));
    await turn(s, c, 2500, "maybe me");
    check("  a doubtful turn after a recognised one in the same call: answered (the call's voice)", created(s) === 2 && spoke.length === 0, JSON.stringify(spoke));
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check("  the ledger says what was done", rows.map((r) => r.acted).join("|") === "answered|ignored|answered (the call's speaker)" && rows.every((r) => r.gated === 1), JSON.stringify(rows.map((r) => r.acted)));
    c.close("test");
  }
  db.voiceprintChecksDelete("relayuser");
  {
    const dbgLogs = relayCall(vp, me);
    const { c, spoke } = dbgLogs;
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const unsure = await turn(s, c, 2500, "maybe me");
    await sleep(300);
    check("GATE, nothing recognised yet in the call: unsure is not answered, and JOYA AI says nothing", created(s) === 0 && deleted(s, unsure) && spoke.length === 0 && c.diag.created === 0, JSON.stringify(spoke));
    check("  the page's pill is told (unsure, gated)", dbgLogs.client.json.some((m) => m.type === "voiceprint" && m.kind === "unsure" && m.gated === true));
    await turn(s, c, 2500, "maybe me again");
    check("  again: still silent", created(s) === 0 && spoke.length === 0);
    await turn(s, c, 2500, "go on please", { ms: 400 }); // the fake counts the padding as speech: ~750 ms
    check("  a very short doubtful turn is let through (too short to check)", created(s) === 1 && spoke.length === 0, created(s) + " " + dbgLogs.logs.slice(-6).join("\n"));
    await turn(s, c, 1000, "it's me");
    await turn(s, c, 2500, "and now?");
    check("  once a turn is recognised, the next doubtful one is answered", created(s) === 3);
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check("  the ledger says what was done", rows.map((r) => r.acted).join("|") === "not answered (unsure)|not answered (unsure)|answered (too short to check)|answered|answered (the call's speaker)", JSON.stringify(rows.map((r) => r.acted)) + "\n" + dbgLogs.logs.filter((l) => /voiceprint/.test(l)).join("\n"));
    c.close("test");
  }
  {
    // 2026-10-07: the page streams audio before the upstream session is open; OpenAI times turns on its
    // own session's audio. The scored audio must be the turn's, not audio from before it.
    db.voiceprintChecksDelete("relayuser");
    const { c } = relayCall(vp, me);
    c.audioIn(tone(2000, 1200)); // someone else, BEFORE the session is open (not sent upstream)
    c.audioIn(tone(0, 300));
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const upAt = c.inputMs; // our timeline; upstream's starts at 0 here
    c.audioIn(tone(0, 500));
    c.audioIn(tone(1000, 1500)); // the administrator's turn
    c.audioIn(tone(0, 300));
    const before = svc.calls.length;
    s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: 500 - 300, item_id: "item_al" });
    s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 2000, item_id: "item_al" });
    s.push({ type: "input_audio_buffer.committed", item_id: "item_al" });
    s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_al", content_index: 0, transcript: "what is the disk usage?" });
    await sleep(150);
    const call = svc.calls.slice(before).find((x) => /\/embed/.test(x.path));
    check("timeline: a turn's audio is the turn's, though the page sent audio before the session opened", call && call.who === "user" && created(s) === 1, JSON.stringify({ call, upAt, base: c.upBase }));
    check("  upBase is where this session's audio began", c.upBase === upAt, c.upBase + " vs " + upAt);
    // after a reconnect, the new session counts from 0 again
    await c.swapUpstream({}, { reason: "drop" });
    await sleep(1800); // the "I'm back" line plays first (speakers mode: the microphone waits)
    const s2 = mock.sessions[mock.sessions.length - 1];
    const up2 = c.inputMs;
    c.audioIn(tone(0, 400));
    c.audioIn(tone(1000, 1500));
    c.audioIn(tone(0, 300));
    const before2 = svc.calls.length;
    s2.push({ type: "input_audio_buffer.speech_started", audio_start_ms: 100, item_id: "item_al2" });
    s2.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 1900, item_id: "item_al2" });
    s2.push({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_al2", content_index: 0, transcript: "and the memory?" });
    await sleep(150);
    const call2 = svc.calls.slice(before2).find((x) => /\/embed/.test(x.path));
    check("  and after the upstream session was replaced (its count starts again at 0)", call2 && call2.who === "user" && c.upBase === up2, JSON.stringify({ call2, base: c.upBase, up2 }));
    c.close("test");
  }
  {
    const dbg = relayCall(vp, me, { confirm: true });
    const { c, heardConfirm, client } = dbg;
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 2000, "yes");
    check("GATE: a “yes” in another voice confirms nothing", heardConfirm.length === 0 && !client.json.some((m) => m.type === "ui-confirmed"));
    await turn(s, c, 2000, "yes", { ms: 600 });
    check("  not even a short one", heardConfirm.length === 0);
    await turn(s, c, 1000, "yes");
    check("  your “yes” does", heardConfirm.length === 1 && client.json.some((m) => m.type === "ui-confirmed"), JSON.stringify({ heardConfirm, logs: dbg.logs.filter((l) => /voiceprint|dropped/.test(l)), json: client.json.map((m) => m.type) }));
    c.close("test");
  }
  {
    // JOYA AI's voice leaking back: learned print, a turn over the voice
    await vp.learnTts("marin", tone(3000, 2000));
    const { c, client } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const item = "item_echo";
    c.audioIn(tone(4000, 1500));
    c.lastAudibleAt = Date.now(); // the voice just played
    s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: 0, item_id: item });
    s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
    s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: "the disk is forty one percent full and odoo is running" });
    await sleep(150);
    const row = db.voiceprintChecksSince(0, "relayuser").pop();
    check("GATE: JOYA AI's own voice heard over its playback is dropped, never spoken to (the pill says it was its own voice)", created(s) === 0 && row.verdict === "echo" && row.acted === "dropped (echo)" && client.json.filter((m) => m.type === "voiceprint").every((m) => m.kind === "echo"), JSON.stringify(row));
    c.close("test");
  }

  // switching mid-call
  {
    const { c } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 2000, "first");
    check("mid-call: gate on, another voice ignored", created(s) === 0);
    vp.setGate(false, "test");
    await turn(s, c, 2000, "second");
    check("  the gate switched off in Settings: the next turn is answered (watching again)", created(s) === 1);
    vp.setEnabled(false, "test");
    const before = svc.calls.length;
    await turn(s, c, 2000, "third");
    check("  the voiceprint switched off: the next turn calls nothing and is answered", svc.calls.length === before && created(s) === 2);
    vp.setEnabled(true, "test");
    vp.setGate(true, "test");
    await turn(s, c, 2000, "fourth");
    check("  on again with the gate: the next turn is checked and ignored", svc.calls.length === before + 1 && created(s) === 2);
    c.close("test");
  }

  // fail open with the gate on
  {
    const { c, logs } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    svc.mode = "broken";
    await turn(s, c, 2000, "the service is down");
    svc.mode = "ok";
    svc.delay = 700;
    const t0 = Date.now();
    await turn(s, c, 2000, "the service is slow");
    await until(() => created(s) === 2, 1500);
    const took = Date.now() - t0;
    svc.delay = 0;
    check("FAIL OPEN: with the gate on, a broken and a slow service let the turn through", created(s) === 2, created(s));
    check("  a slow one costs at most ~400 ms", took < 800, took);
    check("  logged, and the ledger says answered (fail open)", logs.some((l) => /voiceprint: error/.test(l)) && db.voiceprintChecksSince(0, "relayuser").slice(-2).every((r) => r.verdict === "error" && r.acted === "answered (fail open)"));
    c.close("test");
  }

  // hold-to-talk
  {
    const { c, client } = relayCall(vp, me, { opts: { turn: "ptt" } });
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const press = async (amp) => {
      c.message({ type: "ptt", on: true });
      c.audioIn(tone(amp, 1200));
      c.message({ type: "ptt", on: false });
      const item = "item_p" + Math.random().toString(36).slice(2, 6);
      s.push({ type: "input_audio_buffer.committed", item_id: item });
      s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: "open the agents page" });
      await sleep(150);
      return item;
    };
    await press(1000);
    check("hold-to-talk, gate on: your press is answered", created(s) === 1);
    const it = await press(2000);
    check("  another voice's press is ignored", created(s) === 1 && deleted(s, it) && client.json.some((m) => m.type === "voiceprint"));
    const rows = db.voiceprintChecksSince(0, "relayuser").slice(-2);
    check("  the ledger counts presses", rows.every((r) => r.mode === "ptt") && rows.map((r) => r.turn).join() === "1,2", JSON.stringify(rows.map((r) => [r.mode, r.turn])));
    c.close("test");
  }
  {
    // JOYA AI's voice is learned from what it plays, only while the voiceprint is on
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "vp-learn-"));
    const vp3 = vpLib.createVoiceprint({ db, priv: fakePriv(dir2), dataDir: dir2, socketPath: sock, log: () => {} });
    const A3 = vp3.addPerson({ name: "AbdElMoniem", user_id: 51, may_command: true });
    await vp3.enrolClip(A3.id, "laptop", "e1", tone(1000, 40000, 16000), 16000);
    await vp3.enrolSave(A3.id, "laptop");
    vp3.setGate(false, "test");
    const { c } = relayCall(vp3, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "tell me a story");
    const rid = "resp_learn";
    s.push({ type: "response.created", response: { id: rid } });
    s.push({ type: "response.output_item.added", item: { id: "ia", type: "message" } });
    for (let i = 0; i < 12; i++) {
      s.push({ type: "response.output_audio_transcript.delta", item_id: "ia", delta: "Once upon a time there was a quiet garden. " });
      s.push({ type: "response.output_audio.delta", item_id: "ia", delta: tone(3000, 200).toString("base64") });
    }
    s.push({ type: "response.done", response: { id: rid, status: "completed", output: [] } });
    await until(() => !!vp3.ttsPrint("marin"), 1500);
    check("JOYA AI's voice print is learned from what the relay played", !!vp3.ttsPrint("marin"));
    c.close("test");
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  await namesTests(sock, vp, me, A, Zp);
  vp.setGate(false, "test");
  vp.setEnabled(true, "test");
  fs.rmSync(dir, { recursive: true, force: true });
}

const notes = (s) => s.of("conversation.item.create").map((x) => ((x.item.content || [])[0] || {}).text || "").filter((t) => /^\(System note, not the speaker/.test(t));

async function namesTests(sock, vp, me, A, Zp) {
  section("2b. the relay: speakers by name");
  vp.setEnabled(true, "test");
  for (const gate of [false, true]) {
    vp.setGate(gate, "test");
    db.voiceprintChecksDelete("relayuser");
    const { c, client, logs } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const g = gate ? "GATE" : "SHADOW";
    await turn(s, c, 1000, "hello");
    let n = notes(s);
    check(`${g} A: the first recognised turn: one note to address AbdElMoniem by name («عبد المنعم»)`, n.length === 1 && /recognised as "AbdElMoniem" \(in Arabic: «عبد المنعم»\)/.test(n[0]) && /addressing them by that name, once/.test(n[0]) && !/different person/.test(n[0]) && !/may not give commands/.test(n[0]), JSON.stringify(n));
    await turn(s, c, 1000, "and the memory?");
    check(`${g}   A again: no new note (the name is said once, not every turn)`, notes(s).length === 1);
    await turn(s, c, 1250, "ازيك يا جويا");
    n = notes(s);
    check(`${g} B: Zaghloul speaks: a note with his name, a different person, talk only`, n.length === 2 && /recognised as "Zaghloul" \(in Arabic: «زغلول»\), a different person/.test(n[1]) && /Zaghloul may talk with you but may not give commands/.test(n[1]), JSON.stringify(n));
    await turn(s, c, 1250, "and the weather?");
    n = notes(s);
    check(`${g}   B again: only the talk-only reminder, no name`, n.length === 3 && !/recognised as/.test(n[2]) && /may not give commands/.test(n[2]), JSON.stringify(n.slice(2)));
    await turn(s, c, 1000, "it's me again");
    n = notes(s);
    check(`${g} A: back to AbdElMoniem: his name again, may give commands`, n.length === 4 && /recognised as "AbdElMoniem"/.test(n[3]) && !/may not give commands/.test(n[3]), JSON.stringify(n.slice(3)));
    check(`${g}   all five turns answered`, created(s) === 5, created(s));
    const ev = client.json.filter((m) => m.type === "voiceprint");
    check(`${g}   the pill: names, talk only for Zaghloul, gated=${gate}`, ev.map((m) => m.name + (m.talkOnly ? "*" : "")).join() === "AbdElMoniem,AbdElMoniem,Zaghloul*,Zaghloul*,AbdElMoniem" && ev.every((m) => m.kind === "known" && m.gated === gate && !("score" in m)), JSON.stringify(ev));
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check(`${g}   the ledger records who spoke`, rows.map((r) => r.speaker).join() === "AbdElMoniem,AbdElMoniem,Zaghloul,Zaghloul,AbdElMoniem" && rows[2].speaker_id === Zp.id && /talk only/.test(rows[2].acted) && !/talk only/.test(rows[0].acted), JSON.stringify(rows.map((r) => [r.speaker, r.acted])));
    c.close("test");
    check(`${g}   the call's log line: the sequence of speakers`, logs.some((l) => /speakers: AbdElMoniem → Zaghloul → AbdElMoniem$/.test(l)), logs.filter((l) => /speakers/.test(l)).join("\n"));
  }

  // the gate: an unknown voice between them, and a voice too close to both
  vp.setGate(true, "test");
  {
    const { c, client } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const t = await turn(s, c, 1500, "hmm");
    check("GATE: a voice too close to two stored people, nobody named yet in the call: not answered (not sure who)", created(s) === 0 && deleted(s, t), created(s));
    await turn(s, c, 1000, "hello");
    const o = await turn(s, c, 2000, "who are you?");
    check("  an unknown voice: not answered", created(s) === 1 && deleted(s, o), created(s));
    await turn(s, c, 1500, "hmm");
    check("  the too-close voice once AbdElMoniem is the call's speaker: him (no new name note)", created(s) === 2 && notes(s).length === 1, created(s) + " " + notes(s).length);
    const ev = client.json.filter((m) => m.type === "voiceprint").map((m) => m.kind + (m.name ? ":" + m.name : ""));
    check("  the pill: unsure, AbdElMoniem, unknown voice, AbdElMoniem", ev.join() === "unsure,known:AbdElMoniem,other,known:AbdElMoniem", ev.join());
    c.close("test");
  }

  // talk only: what Zaghloul may and may not do
  vp.setGate(false, "test");
  {
    const dbg = relayCall(vp, me, { confirm: true });
    const { c, client, heardConfirm, spoke } = dbg;
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1250, "yes");
    check("TALK ONLY: Zaghloul's “yes” confirms nothing", heardConfirm.length === 0 && !client.json.some((m) => m.type === "ui-confirmed"));
    const fake = { turn: { n: 1, talkOnly: true, talkOnlyName: "Zaghloul" } };
    const r1 = await c.runTool({ name: "look_into", arguments: JSON.stringify({ text: "restart odoo" }) }, fake);
    const r2 = await c.runTool({ name: "ui_action", arguments: JSON.stringify({ action: "open", target: "agents" }) }, fake);
    check("  look_into and ui_action are refused for him (conversational only)", /refused: Zaghloul may talk with you but may not give commands/.test(r1) && /refused: Zaghloul/.test(r2), r1 + " | " + r2);
    check("  and logged", dbg.logs.some((l) => /refused look_into: Zaghloul may not give commands/.test(l)));
    let asked = null;
    c.d.ops = { ...c.d.ops, ask: async (req) => ((asked = req), { turn: { id: "t1", status: "queued" } }) };
    const p = await c.passOn({ n: 1, talkOnly: true, talkOnlyName: "Zaghloul" }, "restart odoo");
    check("  no hand-off to JOYA AI for him", p === null && asked === null && dbg.logs.some((l) => /not passed to JOYA AI: Zaghloul may not give commands/.test(l)), JSON.stringify(p));
    void spoke;
    await c.passOn({ n: 2, speaker: { name: "AbdElMoniem" } }, "restart odoo");
    check("HAND-OFF: AbdElMoniem's request reaches JOYA AI as “[speaker: AbdElMoniem] …”", asked === "[speaker: AbdElMoniem] restart odoo", JSON.stringify(asked));
    c.close("test");
  }
  vp.setGate(false, "test");
}

/* -------------------------------------------- 3. the routes ------------ */

async function routes(sock) {
  section("3. the routes (scratch copy of server.js)");
  const s = await scratch.startScratch({ fakeVoiceprint: true, fakeVoiceOptions: true, env: { JOYA_VOICEPRINT_SOCKET: sock } });
  try {
    await s.makeUser("vpadmin", "administrator");
    await s.makeUser("vpop", "operator-vp2", ["joyaai.use", "os.view"]);
    const ad = await s.signIn("vpadmin");
    const op = await s.signIn("vpop");
    const page = async () => s.req("GET", "/joya-ai/settings/voice", { cookie: ad.cookie });
    let pg = await page();
    const csrf = s.csrfOf(pg.body);
    const post = (p, body, who) => s.req("POST", p, { cookie: (who || ad).cookie, body: new URLSearchParams({ _csrf: csrf, ...(body || {}) }).toString(), headers: { Accept: "application/json" } });
    await post("/joya-ai/settings/voice/enabled", { enabled: "1" });
    pg = await page();
    check("Settings ▸ Voice has the Voiceprint group: On by default, “Only respond to stored voices” greyed (none stored), an empty list of stored voiceprints", pg.status === 200 && /id="v-vp"/.test(pg.body) && /id="vp-enabled"[^>]*checked/.test(pg.body) && /id="vp-gate"[^>]*disabled/.test(pg.body) && /Store a voiceprint first/.test(pg.body) && /Only respond to stored voices/.test(pg.body) && /id="v-vp-people"/.test(pg.body) && /id="vp-add"/.test(pg.body) && !/Your voiceprint/.test(pg.body), pg.status);
    check("  the help says a voice identifies and never approves anything", /A voice identifies; it never approves anything/.test(pg.body));
    check("  with the model's attribution", /WeSpeaker ResNet34-LM/.test(pg.body) && /CC-BY-4\.0/.test(pg.body));
    let r = await post("/joya-ai/settings/voice/voiceprint/gate", { gate: "1" });
    check("the gate needs a stored voiceprint", r.status === 400 && /Store a voiceprint first/.test(r.body), r.body);
    r = await post("/joya-ai/settings/voice/voiceprint", {});
    pg = await page();
    check("switching it off: saved, audited, the gate row greyed with the reason", r.status === 200 && db.getSetting("voiceprint_enabled") === "off" && /id="vp-enabled"(?![^>]*checked)/.test(pg.body) && /The voiceprint is off\./.test(pg.body) && db.recentLogins(20).some((x) => /voiceprint off/.test(x.detail || "")));
    r = await post("/joya-ai/settings/voice/voiceprint", { enabled: "1" });
    check("  and on again", r.status === 200 && db.getSetting("voiceprint_enabled") === "on");
    check("without voice.manage: refused", (await post("/joya-ai/settings/voice/voiceprint", {}, op)).status === 403 && db.getSetting("voiceprint_enabled") === "on");
    check("without CSRF: refused", (await s.req("POST", "/joya-ai/settings/voice/voiceprint", { cookie: ad.cookie, body: "enabled=1", headers: { Accept: "application/json" } })).status === 403);

    // Strictness: presets, Advanced, reset; merged into voiceprint_thresholds
    {
      const TH = "voiceprint_thresholds";
      const stored = () => JSON.parse(db.getSetting(TH, "{}") || "{}");
      db.setSetting(TH, JSON.stringify({ first: 3, timeoutMs: 350, accept: 0.3 }), "test");
      pg = await page();
      check("Strictness: a stored accept of 0.30 reads as custom; the active values are shown", /id="vp-custom"/.test(pg.body) && /<details class="vp-adv" id="vp-adv" open>/.test(pg.body) && /id="vp-active">Now: recognised from 0\.3; unknown below 0\.2; the call's speaker from 0\.2; JOYA AI's own voice from 0\.45 \(custom\)/.test(pg.body), (pg.body.match(/id="vp-active">[^<]*/) || [""])[0]);
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { preset: "strict" });
      check("  Strict: call's voice 0.25, the other three back to defaults, other keys kept (merge)", r.status === 200 && JSON.stringify(stored()) === JSON.stringify({ first: 3, timeoutMs: 350, stickyMin: 0.25 }), JSON.stringify(stored()));
      check("  audited, with the values before and after", db.recentLogins(10).some((x) => /voiceprint strictness: Strict \(accept 0\.31, reject 0\.2, call's voice 0\.25, echo 0\.45; was accept 0\.3, reject 0\.2, call's voice 0\.2, echo 0\.45\)/.test(x.detail || "")), db.recentLogins(3).map((x) => x.detail).join("\n"));
      pg = await page();
      check("  the page shows Strict selected, with its effect line", /<label class="vp-preset on"><input type="radio" name="preset" value="strict" checked>/.test(pg.body) && /about 9 % of unknown voices/.test(pg.body) && /\(Strict\)/.test(pg.body));
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { preset: "very_strict" });
      check("  Very strict: 0.31", stored().stickyMin === 0.31 && stored().first === 3);
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { preset: "relaxed" });
      check("  Relaxed: 0.20", stored().stickyMin === 0.2);
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { preset: "paranoid" });
      check("  an unknown preset is refused", r.status === 400 && stored().stickyMin === 0.2);
      const before = JSON.stringify(stored());
      for (const [why, f, re] of [
        ["accept above 0.80", { accept: "0.9", reject: "0.2", stickyMin: "0.25", echo: "0.45" }, /between 0\.05 and 0\.8/],
        ["echo below 0.20", { accept: "0.31", reject: "0.2", stickyMin: "0.25", echo: "0.1" }, /Echo must be between 0\.2 and 0\.9/],
        ["reject not below the call's-voice minimum", { accept: "0.31", reject: "0.25", stickyMin: "0.25", echo: "0.45" }, /must be lower than/],
        ["the call's-voice minimum above accept", { accept: "0.3", reject: "0.2", stickyMin: "0.35", echo: "0.45" }, /must not be above/],
        ["not a number", { accept: "abc", reject: "0.2", stickyMin: "0.25", echo: "0.45" }, /must be a number/],
        ["a field missing", { accept: "0.31", reject: "0.2", echo: "0.45" }, /must be a number/],
      ]) {
        r = await post("/joya-ai/settings/voice/voiceprint/strictness", f);
        check(`  Advanced refuses ${why}, and nothing changes`, r.status === 400 && re.test(r.body) && JSON.stringify(stored()) === before, r.body.slice(0, 200));
      }
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { accept: "0.33", reject: "0.18", stickyMin: "0.27", echo: "0.5" });
      check("  Advanced saves valid values, merged", r.status === 200 && JSON.stringify(stored()) === JSON.stringify({ first: 3, timeoutMs: 350, stickyMin: 0.27, accept: 0.33, reject: 0.18, echo: 0.5 }), JSON.stringify(stored()));
      check("  and the library uses them", (() => { const t = JSON.parse(db.getSetting(TH)); return t.accept === 0.33; })());
      r = await post("/joya-ai/settings/voice/voiceprint/strictness", { reset: "1", accept: "0.5" });
      check("  Reset to defaults: the four go, other keys stay", r.status === 200 && JSON.stringify(stored()) === JSON.stringify({ first: 3, timeoutMs: 350 }), JSON.stringify(stored()));
      check("  without voice.manage or CSRF: refused", (await post("/joya-ai/settings/voice/voiceprint/strictness", { preset: "strict" }, op)).status === 403 && (await s.req("POST", "/joya-ai/settings/voice/voiceprint/strictness", { cookie: ad.cookie, body: "preset=strict", headers: { Accept: "application/json" } })).status === 403 && !("stickyMin" in stored()));
      db.setSetting(TH, "{}", "test");
    }

    // my own voiceprint, through the guided enrolment (the voiceprint trial was removed on 2026-10-25)
    const wav24 = (amp, sec) => {
      const pcm = tone(amp, sec * 1000);
      const h = Buffer.alloc(44);
      h.write("RIFF", 0, "ascii");
      h.writeUInt32LE(36 + pcm.length, 4);
      h.write("WAVEfmt ", 8, "ascii");
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write("data", 36, "ascii");
      h.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([h, pcm]);
    };
    const rawPost = (p, body, headers) =>
      new Promise((resolve, reject) => {
        const q = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: p, headers: { "X-Forwarded-Proto": "https", Cookie: ad.cookie, "Content-Type": "audio/wav", "Content-Length": body.length, ...(headers || {}) } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        });
        q.on("error", reject);
        q.end(body);
      });
    pg = await page();
    check("no trial recordings are offered any more", !/vp-from-trial|from-trial|voiceprint-trial/.test(pg.body));
    check("  and the old route is gone", (await post("/joya-ai/settings/voice/voiceprint/from-trial", { slot: "laptop" })).status === 404);
    r = await s.req("POST", "/joya-ai/settings/voice/voiceprint/people", { cookie: ad.cookie, body: new URLSearchParams({ _csrf: csrf, name: "vpadmin", me: "1" }).toString() });
    const vpFile = path.join(s.data, "voiceprint");
    const peopleJson = () => JSON.parse(fs.readFileSync(path.join(vpFile, "people.json"), "utf8"));
    const meId0 = (peopleJson().people[0] || {}).id;
    const mp = await s.req("GET", "/joya-ai/voiceprint/enrol?person=" + meId0, { cookie: ad.cookie });
    const mcsrf = s.csrfOf(mp.body);
    for (const id of ["e1", "e2", "e3", "e4"]) await rawPost("/joya-ai/api/voiceprint/enrol-clip?person=" + meId0 + "&mic=laptop&id=" + id, wav24(1000, 12), { "X-CSRF-Token": mcsrf });
    r = await s.req("POST", "/joya-ai/api/voiceprint/enrol-save", { cookie: ad.cookie, body: { person: meId0, mic: "laptop" }, headers: { "X-CSRF-Token": mcsrf } });
    const pj = fs.existsSync(path.join(vpFile, "people.json")) ? peopleJson() : { people: [] };
    check("enrol my own voice (Add and enrol, then 4 paragraphs on the laptop): a stored voiceprint for the signed-in user, sealed on disk", r.status === 200 && pj.people.length === 1 && pj.people[0].user_id != null && pj.people[0].may_command === true && !/"sum"/.test(fs.readFileSync(path.join(vpFile, "people.json"), "utf8")), r.body);
    const meId = pj.people[0] && pj.people[0].id;
    pg = await page();
    check("  the page lists it (name, linked user, microphone, may give commands on), and the gate can be switched on", new RegExp(`data-person="${meId}"`).test(pg.body) && /class="tag-s"[^>]*>vpadmin</.test(pg.body) && /class="vp-mics"/.test(pg.body) && /Laptop microphone/.test(pg.body) && !/id="vp-gate"[^>]*disabled/.test(pg.body), JSON.stringify([new RegExp(`data-person="${meId}"`).test(pg.body), /class="tag-s"[^>]*>vpadmin</.test(pg.body), /class="vp-mics"/.test(pg.body), /Laptop microphone/.test(pg.body), !/id="vp-gate"[^>]*disabled/.test(pg.body)]));
    r = await post("/joya-ai/settings/voice/voiceprint/gate", { gate: "1" });
    check("  gate on: saved and audited", r.status === 200 && db.getSetting("voiceprint_gate") === "on" && db.recentLogins(20).some((x) => /only respond to stored voices on/.test(x.detail || "")));

    // add a person: a plain form, the browser follows the 303 to their enrolment page
    const plain = (p, body) => s.req("POST", p, { cookie: ad.cookie, body: new URLSearchParams({ _csrf: csrf, ...(body || {}) }).toString() });
    r = await plain("/joya-ai/settings/voice/voiceprint/people", { name: "Zaghloul", spoken: "زغلول" });
    const zid = (peopleJson().people.find((x) => x.name === "Zaghloul") || {}).id;
    check("add Zaghloul («زغلول»): 303 to his enrolment page; not linked, may NOT give commands; audited", r.status === 303 && r.headers.location === "/joya-ai/voiceprint/enrol?person=" + zid && peopleJson().people.find((x) => x.id === zid).may_command === false && peopleJson().people.find((x) => x.id === zid).user_id === null && db.recentLogins(10).some((x) => /voiceprint: added Zaghloul, may give commands off/.test(x.detail || "")), r.status + " " + JSON.stringify(r.headers.location));
    r = await post("/joya-ai/settings/voice/voiceprint/people", { name: "zaghloul" });
    check("  a duplicate name is refused", r.status === 400 && /already a voiceprint called/.test(r.body), r.body);
    r = await post("/joya-ai/settings/voice/voiceprint/people", { name: "<script>" });
    check("  a bad name is refused", r.status === 400 && /Latin letters/.test(r.body), r.body);
    check("  without voice.manage or CSRF: refused", (await post("/joya-ai/settings/voice/voiceprint/people", { name: "Eve" }, op)).status === 403 && (await s.req("POST", "/joya-ai/settings/voice/voiceprint/people", { cookie: ad.cookie, body: "name=Eve", headers: { Accept: "application/json" } })).status === 403 && peopleJson().people.length === 2);
    pg = await page();
    check("  Zaghloul is listed: spoken name, not enrolled, may give commands off", new RegExp(`data-person="${zid}"`).test(pg.body) && /«زغلول»/.test(pg.body) && /not enrolled/.test(pg.body));
    r = await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/command`, { may: "1" });
    check("May give commands: on, audited", r.status === 200 && peopleJson().people.find((x) => x.id === zid).may_command === true && db.recentLogins(10).some((x) => /Zaghloul may give commands on/.test(x.detail || "")));
    r = await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/command`, {});
    check("  and off again", r.status === 200 && peopleJson().people.find((x) => x.id === zid).may_command === false);
    r = await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/rename`, { name: "Zaghloul B", spoken: "زغلول" });
    check("rename, audited", r.status === 200 && peopleJson().people.find((x) => x.id === zid).name === "Zaghloul B" && db.recentLogins(10).some((x) => /renamed Zaghloul to Zaghloul B/.test(x.detail || "")), r.body);
    await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/rename`, { name: "Zaghloul", spoken: "زغلول" });
    check("  an unknown id: refused", (await post("/joya-ai/settings/voice/voiceprint/people/pdeadbeef/rename", { name: "X" })).status === 400);

    // the enrolment page and its calls
    const nop = await s.req("GET", "/joya-ai/voiceprint/enrol", { cookie: ad.cookie });
    check("the enrolment page without a person: back to the list", nop.status === 302 && /#v-vp-people$/.test(nop.headers.location || ""), nop.status);
    const mine = await s.req("GET", "/joya-ai/voiceprint/enrol?person=" + meId, { cookie: ad.cookie });
    check("  for my own voiceprint: no consent note", mine.status === 200 && !/id="vpe-consent"/.test(mine.body));
    const ep = await s.req("GET", "/joya-ai/voiceprint/enrol?person=" + zid, { cookie: ad.cookie });
    check("  for Zaghloul: his name and the consent note “Only record someone who agreed to it”", ep.status === 200 && /id="vpe-consent"/.test(ep.body) && /Only record someone who agreed to it/.test(ep.body) && /Zaghloul/.test(ep.body) && new RegExp(`data-person="${zid}"`).test(ep.body));
    check("the enrolment page renders (4 paragraphs, no inline script or style)", ep.status === 200 && (ep.body.match(/data-rec="e\d"/g) || []).length === 4 && !/\sstyle="/.test(ep.body) && !/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(ep.body.replace(/<script type="application\/(ld\+)?json"[\s\S]*?<\/script>/g, "")));
    check("  not for a role without voice.manage", (await s.req("GET", "/joya-ai/voiceprint/enrol?person=" + zid, { cookie: op.cookie })).status === 403);
    const ecsrf = s.csrfOf(ep.body);
    check("  a clip without CSRF is refused", (await rawPost("/joya-ai/api/voiceprint/enrol-clip?person=" + zid + "&mic=headset&id=e1", wav24(1000, 10))).status === 403);
    let tot = 0;
    for (const id of ["e1", "e2", "e3"]) {
      const x = await rawPost("/joya-ai/api/voiceprint/enrol-clip?person=" + zid + "&mic=headset&id=" + id, wav24(1250, 12), { "X-CSRF-Token": ecsrf });
      tot = JSON.parse(x.body).total_s;
    }
    check("  each clip is learned at once; the total grows", tot === 36, tot);
    check("  nothing of the audio is kept on disk", !fs.readdirSync(s.data, { recursive: true }).some((f) => /headset/.test(String(f))));
    const save = await s.req("POST", "/joya-ai/api/voiceprint/enrol-save", { cookie: ad.cookie, body: { person: zid, mic: "headset" }, headers: { "X-CSRF-Token": ecsrf } });
    check("  saved: Zaghloul is enrolled (headset); AbdElMoniem's print untouched", save.status === 200 && JSON.parse(save.body).name === "Zaghloul" && JSON.parse(save.body).mics.join() === "headset" && Object.keys(peopleJson().people.find((x) => x.id === meId).mics).join() === "laptop", save.body);
    const st = await s.req("GET", "/joya-ai/api/voiceprint/enrol-status?person=" + zid + "&mic=headset", { cookie: ad.cookie });
    check("  and the pending sums are gone", JSON.parse(st.body).clips.length === 0);
    const bad = await rawPost("/joya-ai/api/voiceprint/enrol-clip?person=" + zid + "&mic=headset&id=e1", wav24(1000, 1), { "X-CSRF-Token": ecsrf });
    check("  a 1 s paragraph is refused", bad.status === 400);

    // the service down: the warning
    svc.mode = "broken";
    pg = await page();
    svc.mode = "ok";
    check("the service down: Settings warns (fail open)", /id="vp-service-warn"/.test(pg.body) && /nothing is blocked/.test(pg.body));

    // remove a mic, delete, delete everything
    db.voiceprintChecksDeleteAll();
    db.voiceprintCheckInsert({ ts: Date.now(), actor: "vpadmin", verdict: "accept", score: 0.6, acted: "shadow", speaker_id: zid, speaker: "Zaghloul" });
    pg = await page();
    check("the last 7 days are shown per person, with the histogram", /id="vp-stats"/.test(pg.body) && /<svg class="vp-hist"/.test(pg.body) && /1<\/b> turns checked/.test(pg.body) && /Zaghloul/.test(pg.body.slice(pg.body.indexOf('id="vp-stats"'))), pg.body.slice(pg.body.indexOf('id="vp-stats"'), pg.body.indexOf('id="vp-stats"') + 600));
    // more people, to the limit of 10
    for (let i = 0; i < 8; i++) await post("/joya-ai/settings/voice/voiceprint/people", { name: "Guest " + i });
    r = await post("/joya-ai/settings/voice/voiceprint/people", { name: "Eleven" });
    pg = await page();
    check("at most 10 stored voiceprints: the 11th refused, the add form replaced by the limit note", r.status === 400 && /At most 10/.test(r.body) && peopleJson().people.length === 10 && !/id="vp-add"/.test(pg.body) && /At most 10 stored voiceprints\./.test(pg.body), r.status + " " + peopleJson().people.length);
    for (const x of peopleJson().people.filter((x) => /^Guest/.test(x.name))) await post(`/joya-ai/settings/voice/voiceprint/people/${x.id}/delete`, {});
    r = await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/remove-mic`, { mic: "headset" });
    pg = await page();
    check("remove Zaghloul's only microphone: he stays, not enrolled; the gate stays (AbdElMoniem is stored)", r.status === 200 && peopleJson().people.some((x) => x.id === zid) && /not enrolled/.test(pg.body) && db.getSetting("voiceprint_gate") === "on");
    r = await post(`/joya-ai/settings/voice/voiceprint/people/${zid}/delete`, {});
    check("delete Zaghloul: only his; audited", r.status === 200 && peopleJson().people.map((x) => x.name).join() === "vpadmin" && db.recentLogins(10).some((x) => /deleted Zaghloul's voiceprint/.test(x.detail || "")), JSON.stringify(peopleJson().people.map((x) => x.name)));
    r = await post("/joya-ai/settings/voice/voiceprint/forget-all", {});
    check("delete everything: voiceprint, ledger, the key; the gate off", r.status === 200 && (!fs.existsSync(path.join(vpFile, "people.json")) || peopleJson().people.length === 0) && db.voiceprintChecksSince(0, "vpadmin").length === 0 && JSON.parse(fs.readFileSync(path.join(s.data, "fake-vp-forget.json"), "utf8")).keepKey === false && db.getSetting("voiceprint_gate") === "off", r.body);
    check("  audited with counts only", db.recentLogins(30).some((x) => /deleted everything \(1 voiceprints, key deleted, 0 result folders, 1 check rows\)/.test(x.detail || "")), db.recentLogins(5).map((x) => x.detail).join("\n"));
    await browser(s, ad);
  } finally {
    s.stop();
  }
}

/* ------------------------------ the pill's words (public/cc-logic.js) ---- */

function pure() {
  section("the state pill's words (public/cc-logic.js vpBadge)");
  const ML = require(path.join(ROOT, "public", "cc-logic.js"));
  const b = (k, g, n, t) => ML.vpBadge(k, g, n, t);
  check("recognised: “Recognised: AbdElMoniem”, joya, a check", b("known", true, "AbdElMoniem").label === "Recognised: AbdElMoniem" && b("known", false, "AbdElMoniem").tone === "ok" && b("known", true, "AbdElMoniem").icon === "you");
  check("a stored person who may not give commands: “Zaghloul — talk only”, neutral", b("known", true, "Zaghloul", true).label === "Zaghloul — talk only" && b("known", true, "Zaghloul", true).tone === "mid");
  check("unknown voice: red; gate on 'Didn't recognise your voice, try again' (2026-10-21: no longer dropped silently), shadow '— would be ignored'", b("other", true).label === "Didn't recognise your voice, try again" && b("other", false).label === "Unknown voice — would be ignored" && b("other", true).tone === "bad");
  check("unsure: “Not sure who's speaking”, neutral; gate on '— not answered'; too short: the same words", b("unsure", false).label === "Not sure who's speaking" && b("unsure", true).label === "Not sure who's speaking — not answered" && b("short", true).label === "Not sure who's speaking" && b("unsure", true).tone === "mid");
  check("JOYA AI's own voice: red, ignored / would be", /own voice — ignored$/.test(b("echo", true).label) && /would be ignored$/.test(b("echo", false).label));
  check("a name is one line, cut at 40", b("known", true, "A\nB").label === "Recognised: A B" && b("known", true, "x".repeat(60)).label.length <= 12 + 40);
  check("nothing for an unknown kind; no number anywhere", b("error", true) === null && ["known", "other", "echo", "unsure", "short"].every((k) => !/\d/.test(b(k, true, "Zaghloul").label + b(k, false).label)));
  check("shown 1.5-2.6 s", ML.VP_MIN_MS === 1500 && ML.VP_SHOW_MS === 2600);
}

/* -------------------------------------------- the pill in the browser ---- */

const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.4";
async function pill(s, ad, chromium) {
  section("the state pill: the verdict per turn (web Command Center and the desktop app)");
  const b = await chromium.launch();
  const cookies = ad.cookie.split("; ").map((c) => ({ name: c.slice(0, c.indexOf("=")), value: c.slice(c.indexOf("=") + 1), domain: "127.0.0.1", path: "/" }));
  const views = [
    { name: "web 1440", W: 1440, H: 900, q: "/joya-ai", ua: null },
    { name: "web 390", W: 390, H: 844, q: "/joya-ai", ua: null },
    { name: "app floating M", W: 480, H: 860, q: "/joya-ai?shell=desktop&mode=floating", ua: APP_UA },
    { name: "app floating S", W: 384, H: 744, q: "/joya-ai?shell=desktop&mode=floating&size=S", ua: APP_UA },
    { name: "app floating L", W: 586, H: 1050, q: "/joya-ai?shell=desktop&mode=floating&size=L", ua: APP_UA },
    { name: "app desktop layer", W: 1440, H: 852, q: "/joya-ai?shell=desktop&mode=desktop", ua: APP_UA },
    { name: "app peek", W: 1440, H: 852, q: "/joya-ai?shell=desktop&mode=peek", ua: APP_UA },
  ];
  const verdicts = [
    ["known", true, "Recognised: AbdElMoniem", "ok", "AbdElMoniem", false],
    ["known", false, "Zaghloul — talk only", "mid", "Zaghloul", true],
    ["other", true, "Didn't recognise your voice, try again", "bad"],
    ["other", false, "Unknown voice — would be ignored", "bad"],
    ["unsure", true, "Not sure who's speaking — not answered", "mid"],
    ["short", false, "Not sure who's speaking", "mid"],
  ];
  const shots = process.env.VP_SHOTS || null;
  try {
    for (const v of views) {
      for (const scheme of ["light", "dark"]) {
        const tag = `${v.name} ${scheme}`;
        const ctx = await b.newContext({ viewport: { width: v.W, height: v.H }, colorScheme: scheme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, ...(v.ua ? { userAgent: v.ua } : {}) });
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (x) => errs.push(x.message));
        page.on("console", (m) => {
          const t = m.text();
          if ((m.type() === "error" && !/Failed to load resource|net::ERR|EventSource|503|502/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t);
        });
        const q = v.q + (v.ua ? "&ink=" + (scheme === "light" ? "dark" : "light") : "");
        await page.goto(`http://127.0.0.1:${s.port}${q}`, { waitUntil: "load" });
        await page.waitForTimeout(500);
        const base = await page.textContent("#cc-cap-label");
        let ok = true;
        const bad = [];
        for (const [kind, gated, label, tone, name, talkOnly] of verdicts) {
          // The scratch copy has no JOYA AI supervisor (offline): the app hides its caption then. Stand it in.
          await page.evaluate((m) => {
            const off = document.getElementById("cc-offline");
            if (off) off.hidden = true;
            window.__joyaCC.S.online = true;
            window.__joyaCC.voiceprint(m);
          }, { kind, gated, name: name || null, talkOnly: !!talkOnly });
          const r = await page.evaluate(() => {
            const p = document.getElementById("cc-cap-state"), r = p.getBoundingClientRect(), ic = document.getElementById("cc-cap-vp");
            return { label: document.getElementById("cc-cap-label").textContent, tone: p.getAttribute("data-vp"), live: document.getElementById("cc-vp-live").textContent, icon: !ic.hidden && ic.getAttribute("data-i"), visible: r.width > 0 && getComputedStyle(p).visibility !== "hidden" && getComputedStyle(p).display !== "none", inWin: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight, color: getComputedStyle(p).color };
          });
          if (!(r.label === label && r.tone === tone && r.live === label + "." && r.icon && r.visible && r.inWin)) {
            ok = false;
            bad.push({ kind, gated, ...r });
          }
          if (shots && scheme === (v.ua ? "dark" : "light")) await page.screenshot({ path: path.join(shots, `pill-${v.name.replace(/\s+/g, "-")}-${kind}-${gated ? "gate" : "shadow"}.png`), clip: await page.evaluate(() => { const r = document.getElementById("cc-cap-state").getBoundingClientRect(); return { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 30), width: Math.min(innerWidth - Math.max(0, r.left - 40), r.width + 80), height: r.height + 60 }; }) }).catch(() => {});
        }
        check(`${tag}: each verdict on the pill (words, colour, icon, read out politely), inside the window`, ok, JSON.stringify(bad));
        await page.waitForTimeout(2800);
        await page.evaluate(() => { window.__joyaCC.S.online = true; const o = document.getElementById("cc-offline"); if (o) o.hidden = true; });
        const base2 = await page.evaluate(() => { return document.getElementById("cc-cap-label").textContent; });
        void base2;
        const after = await page.evaluate(() => ({ label: document.getElementById("cc-cap-label").textContent, vp: document.getElementById("cc-cap-state").getAttribute("data-vp"), ic: document.getElementById("cc-cap-vp").hidden }));
        check(`${tag}: after ~2.6 s back to the state (${after.label})`, !verdicts.some((x) => x[2] === after.label) && after.vp === null && after.ic === true && !!after.label, JSON.stringify({ after, base }));
        check(`${tag}: zero page errors and CSP violations`, errs.length === 0, errs.join("\n"));
        await ctx.close();
      }
    }
  } finally {
    await b.close();
  }
}

/* -------------------------------------------- 4. the pages -------------- */

async function browser(s, ad) {
  section("4. the pages in Chromium");
  let chromium;
  try {
    ({ chromium } = require(process.env.PLAYWRIGHT || "playwright"));
  } catch (e) {
    console.log("  skip no Playwright (set PLAYWRIGHT=/path/to/node_modules/playwright)");
    return;
  }
  const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const cookies = ad.cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: "127.0.0.1", path: "/" };
  });
  let addN = 0;
  try {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      for (const scheme of ["light", "dark"]) {
        const tag = `${w} px ${scheme}`;
        const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["microphone"] });
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (x) => errs.push(x.message));
        page.on("console", (m) => {
          const t = m.text();
          if ((m.type() === "error" && !/Failed to load resource|net::ERR|EventSource|503|502/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t);
        });
        await page.goto(`http://127.0.0.1:${s.port}/joya-ai/settings/voice#v-vp`);
        await page.waitForSelector("#v-vp");
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": Settings ▸ Voice, no horizontal scroll", over <= 0, over);
        check(tag + ": the Voiceprint group is visible, the gate greyed (none stored), the add form shown", (await page.isVisible("#v-vp")) && (await page.isDisabled("#vp-gate")) && (await page.isVisible("#vp-add")));
        // switch it off through the page (os.js sends the form in place, after the confirm)
        await page.locator("#v-voiceprint label.sw").click();
        const yes = await page.waitForSelector('.cc-sdlg [data-a="yes"]', { timeout: 3000 }).catch(() => null);
        // the switch's form reloads the page once it saved: wait for that reload before going on
        const reloaded = page.waitForNavigation({ timeout: 5000 }).catch(() => null);
        if (yes) await yes.click();
        await until(async () => db.getSetting("voiceprint_enabled") === "off", 4000);
        await reloaded;
        check(tag + ": the switch turns it off from the page (with a confirm)", !!yes && db.getSetting("voiceprint_enabled") === "off");
        db.setSetting("voiceprint_enabled", "on", "test");
        // Strictness from the page: a preset card, then Advanced (a bad order refused, a good one saved), then reset.
        // (The switch's form reloads the page itself after saving; a reload of ours raced it -- ERR_ABORTED -- so
        // wait for that to settle and navigate afresh.)
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        const fresh = () => page.goto(`http://127.0.0.1:${s.port}/joya-ai/settings/voice?t=${Date.now()}#v-vp`); // a new URL: a hash-only goto would not reload
        await fresh().catch(() => fresh());
        await page.waitForSelector("#v-vp-strict");
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": Strictness: three presets, no horizontal scroll", (await page.$$("#v-vp-strict .vp-preset")).length === 3 && ov <= 0, ov);
        await page.locator('#v-vp-strict .vp-preset:has(input[value="strict"])').click();
        await until(async () => (JSON.parse(db.getSetting("voiceprint_thresholds", "{}")).stickyMin === 0.25), 4000);
        check(tag + ": clicking Strict saves it in place", JSON.parse(db.getSetting("voiceprint_thresholds", "{}")).stickyMin === 0.25);
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForSelector("#vp-adv");
        if (!(await page.evaluate(() => document.getElementById("vp-adv").open))) await page.click("#vp-adv summary");
        await page.fill('#vp-adv input[name="reject"]', "0.3");
        await page.click("#vp-adv-save");
        await page.waitForSelector("#flash .alert.bad", { timeout: 4000 }).catch(() => {});
        const fl = await page.textContent("#flash").catch(() => "");
        check(tag + ": Advanced: a bad order is refused with the reason, nothing saved", /must be lower than/.test(fl) && JSON.parse(db.getSetting("voiceprint_thresholds", "{}")).reject === undefined, fl);
        await page.fill('#vp-adv input[name="reject"]', "0.18");
        await page.click("#vp-adv-save");
        await until(async () => JSON.parse(db.getSetting("voiceprint_thresholds", "{}")).reject === 0.18, 4000);
        check(tag + ": Advanced: valid values saved", JSON.parse(db.getSetting("voiceprint_thresholds", "{}")).reject === 0.18);
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        if (w === 1440 && scheme === "light") await page.locator("#v-vp-strict").screenshot({ path: path.join(os.tmpdir(), "vp-strict-1440-light.png") }).catch(() => {});
        if (w === 390 && scheme === "dark") await page.locator("#v-vp-strict").screenshot({ path: path.join(os.tmpdir(), "vp-strict-390-dark.png") }).catch(() => {});
        await page.waitForSelector("#vp-adv");
        if (!(await page.evaluate(() => document.getElementById("vp-adv").open))) await page.click("#vp-adv summary");
        await page.click("#vp-adv-reset");
        await until(async () => db.getSetting("voiceprint_thresholds", "{}") === "{}", 4000);
        check(tag + ": Reset to defaults", db.getSetting("voiceprint_thresholds", "{}") === "{}", db.getSetting("voiceprint_thresholds"));
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        if (w === 1440 && scheme === "light") await page.locator("#v-vp").screenshot({ path: path.join(os.tmpdir(), "vp-settings-1440-light.png") }).catch(() => {});
        if (w === 390 && scheme === "dark") await page.locator("#v-vp").screenshot({ path: path.join(os.tmpdir(), "vp-settings-390-dark.png") }).catch(() => {});

        // the switch's form reloads the page after it saved: let that finish before going on
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        // add a person from the page: name + spoken name -> their enrolment page, with the consent note
        const nm = "Zaghloul " + (++addN);
        await page.goto(`http://127.0.0.1:${s.port}/joya-ai/settings/voice#v-vp-people`);
        await page.waitForSelector("#vp-add");
        await page.fill('#vp-add input[name="name"]', nm);
        await page.fill('#vp-add input[name="spoken"]', "زغلول");
        await Promise.all([page.waitForURL(/\/joya-ai\/voiceprint\/enrol\?person=p[0-9a-f]+/, { timeout: 6000 }).catch(() => {}), page.click("#vp-add-btn")]);
        check(tag + ": Add and enrol opens the person's enrolment page", /\/joya-ai\/voiceprint\/enrol\?person=p[0-9a-f]+/.test(page.url()), page.url());
        await page.waitForSelector("#vpe");
        const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": the enrolment page, no horizontal scroll; his name and the consent note shown", over2 <= 0 && (await page.isVisible("#vpe-consent")) && (await page.textContent("#vpe")).includes(nm), over2);
        await page.click('[data-rec="e1"]');
        await page.waitForFunction(() => /recording/.test(document.querySelector('[data-state="e1"]').textContent), null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3600);
        await page.click('[data-rec="e1"]');
        await page.waitForFunction(() => /done ·|refused|Nothing|not answering|HTTP|between/.test(document.querySelector('[data-state="e1"]').textContent), null, { timeout: 8000 }).catch(() => {});
        const st = await page.textContent('[data-state="e1"]');
        check(tag + ": a paragraph recorded through the worklet is learned", /done · \d/.test(st), st);
        check(tag + ": not enough yet: Save stays off", await page.isDisabled("#vpe-save"));
        if (w === 1440 && scheme === "dark") await page.screenshot({ path: path.join(os.tmpdir(), "vp-enrol-1440-dark.png") }).catch(() => {});
        if (w === 390 && scheme === "light") await page.screenshot({ path: path.join(os.tmpdir(), "vp-enrol-390-light.png"), fullPage: true }).catch(() => {});
        // back on Settings: he is listed
        await page.goto(`http://127.0.0.1:${s.port}/joya-ai/settings/voice#v-vp-people`);
        await page.waitForSelector("#v-vp-people");
        const listed = await page.evaluate((n) => [...document.querySelectorAll("#v-vp-people .vp-person")].some((li) => li.textContent.includes(n)), nm);
        const over3 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": Settings lists him, no horizontal scroll", listed && over3 <= 0, over3);
        await page.locator("#v-vp-people").screenshot({ path: path.join(os.tmpdir(), `vp-people-${w}-${scheme}.png`) }).catch(() => {});
        check(tag + ": zero page errors and CSP violations", errs.length === 0, errs.join("\n"));
        await ctx.close();
      }
    }
  } finally {
    await b.close();
  }
  await pill(s, ad, chromium);
}

/* ------------------------------- 5. the real service, the real voice ---- */

async function real() {
  section("5. the real service and the administrator's real recordings");
  const PY = "/root/.local/joya-voiceprint/venv/bin/python";
  const MODEL = "/root/.local/joya-voiceprint/models/wespeaker-voxceleb-resnet34-LM/voxceleb_resnet34_LM.onnx";
  // The administrator's trial recordings: in the panel's data dir until 2026-10-25, then archived under
  // /root/backups/voiceprint-trial-recordings_<stamp>/ (the trial page was removed; the newest archive is used).
  const roots = ["/var/lib/joya-dashboard/voiceprint-trial"];
  try {
    for (const d of fs.readdirSync("/root/backups").filter((d) => /^voiceprint-trial-recordings_/.test(d)).sort().reverse()) roots.push(path.join("/root/backups", d));
  } catch (_) {
    /* no archive */
  }
  let userDir = null;
  for (const trialRoot of roots) {
    try {
      userDir = fs.readdirSync(trialRoot).map((d) => path.join(trialRoot, d)).find((d) => fs.existsSync(path.join(d, "laptop", "e1.wav")));
    } catch (_) {
      userDir = null;
    }
    if (userDir) break;
  }
  if (!fs.existsSync(PY) || !fs.existsSync(MODEL) || !userDir) {
    console.log("  skip no model or no trial recordings on this machine");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-real-"));
  const sock = path.join(dir, "vp.sock");
  const child = spawn(PY, [path.join(ROOT, "..", "voiceprint", "server.py")], { env: { ...process.env, JOYA_VOICEPRINT_SOCKET: sock, JOYA_VOICEPRINT_MODEL: MODEL, JOYA_VOICEPRINT_THREADS: "4" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    check("the real service starts on its socket", await until(() => fs.existsSync(sock), 15000), out);
    await sleep(300);
    const vp = vpLib.createVoiceprint({ db, priv: fakePriv(dir), dataDir: dir, socketPath: sock, log: () => {}, parseWav: trialLib.parseWav });
    const meP = vp.addPerson({ name: "AbdElMoniem", spoken: "", user_id: 99, may_command: true });
    for (const id of ["e1", "e2", "e3", "e4"]) {
      const w = trialLib.parseWav(fs.readFileSync(path.join(userDir, "laptop", id + ".wav")));
      await vp.enrolClip(meP.id, "laptop", id, Buffer.from(w.samples.buffer, w.samples.byteOffset, w.samples.length * 2), w.rate);
    }
    const en = await vp.enrolSave(meP.id, "laptop");
    check("enrolled from the administrator's own trial paragraphs (the guided enrolment's calls)", en.speech_s > 30, JSON.stringify(en));
    // "Zaghloul": a public speaker as the stand-in (LibriSpeech test-clean 1089, CC-BY-4.0), 16 kHz FLAC -> PCM
    const LS = "/root/.local/joya-voiceprint/data/LibriSpeech/test-clean/1089";
    let zFiles = [];
    if (fs.existsSync(LS)) {
      const zDir = path.join(dir, "z");
      fs.mkdirSync(zDir);
      const py = `import soundfile as sf, glob, os, numpy as np\nfs=sorted(glob.glob('${LS}/*/*.flac'))\nfor f in fs[:24]:\n  x,r=sf.read(f,dtype='int16')\n  open(os.path.join('${zDir}',os.path.basename(f)[:-5]+'.pcm'),'wb').write(x.tobytes())\n`;
      require("child_process").execFileSync(PY, ["-c", py]);
      zFiles = fs.readdirSync(zDir).sort().map((f) => path.join(zDir, f));
    }
    const Zp = zFiles.length ? vp.addPerson({ name: "Zaghloul", spoken: "زغلول" }) : null;
    if (Zp) {
      // enrol from the first 8 utterances (as 4 "paragraphs" of two), test on the rest
      for (let i = 0; i < 4; i++) await vp.enrolClip(Zp.id, "laptop", "e" + (i + 1), Buffer.concat([fs.readFileSync(zFiles[2 * i]), fs.readFileSync(zFiles[2 * i + 1])]), 16000);
      const zs = await vp.enrolSave(Zp.id, "laptop");
      check(`Zaghloul (a public speaker as the stand-in) enrolled: ${zs.speech_s} s`, zs.speech_s > 20, JSON.stringify(zs));
    }
    const up24 = (x) => {
      const n = Math.floor((x.length * 3) / 2);
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const p = (i * 2) / 3;
        const a = Math.floor(p);
        const f = p - a;
        const v = (x[a] || 0) * (1 - f) + (x[Math.min(a + 1, x.length - 1)] || 0) * f;
        b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
      }
      return b;
    };
    const pcm24 = (file) => {
      const raw = fs.readFileSync(file);
      return up24(new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1));
    };
    // 16 kHz clip -> 24 kHz PCM, as the relay would send
    const to24 = (file) => up24(trialLib.parseWav(fs.readFileSync(file)).samples);
    const tests = fs.readdirSync(path.join(userDir, "laptop")).filter((f) => /^t\d+\.wav$/.test(f));
    const mine = [];
    for (const f of tests) mine.push(await vp.check(to24(path.join(userDir, "laptop", f)).subarray(0, 4000 * 48), {}));
    const acc = mine.filter((r) => r.verdict === "accept" && r.speaker && r.speaker.name === "AbdElMoniem").length;
    const notRejected = mine.filter((r) => r.verdict !== "reject").length;
    const wrong = mine.filter((r) => r.speaker && r.speaker.name !== "AbdElMoniem").length;
    check(`1-vs-N, your real phrases: ${acc} of ${mine.length} named AbdElMoniem, none rejected, none named Zaghloul`, acc >= mine.length - 2 && notRejected === mine.length && wrong === 0, JSON.stringify(mine.map((r) => [r.verdict, r.speaker && r.speaker.name, r.score, r.second])));
    if (Zp) {
      const zr = [];
      for (const f of zFiles.slice(8)) zr.push(await vp.check(pcm24(f).subarray(0, 4000 * 48), {}));
      const zAcc = zr.filter((r) => r.verdict === "accept" && r.speaker && r.speaker.name === "Zaghloul").length;
      const zWrong = zr.filter((r) => r.speaker && r.speaker.name !== "Zaghloul").length;
      check(`1-vs-N, Zaghloul's other utterances: ${zAcc} of ${zr.length} named Zaghloul, none named AbdElMoniem`, zAcc >= zr.length - 2 && zWrong === 0, JSON.stringify(zr.map((r) => [r.verdict, r.speaker && r.speaker.name, r.score, r.second])));
      // A -> B -> A, through the library's "current speaker": each named on their own turns
      const seq = [];
      let cur = null;
      for (const [who, pcm] of [["A", to24(path.join(userDir, "laptop", tests[0]))], ["B", pcm24(zFiles[10])], ["A", to24(path.join(userDir, "laptop", tests[1]))], ["B", pcm24(zFiles[11])], ["A", to24(path.join(userDir, "laptop", tests[2]))]]) {
        const r = await vp.check(pcm.subarray(0, 4000 * 48), { current: cur });
        if (r.speaker) cur = { id: r.speaker.id, at: Date.now() };
        seq.push(who + ":" + (r.speaker ? r.speaker.name : r.verdict));
      }
      check(`speaker changes A → B → A → B → A with real voices: ${seq.join(" ")}`, seq.join() === "A:AbdElMoniem,B:Zaghloul,A:AbdElMoniem,B:Zaghloul,A:AbdElMoniem", seq.join());
    }
    const others = [];
    const pub = "/root/.local/joya-voiceprint/data/public/cv-ar";
    const pubEn = "/root/.local/joya-voiceprint/data/public/cv-en";
    for (const d of [pub, pubEn]) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).slice(0, 15)) others.push(await vp.check(to24(path.join(d, f)), {}));
    }
    const pass = others.filter((r) => r.verdict === "accept").length;
    check(`unknown people (Common Voice, ${others.length} clips): ${pass} named (as anyone)`, others.length === 0 || pass <= 1, JSON.stringify(others.map((r) => [r.verdict, r.speaker && r.speaker.name, r.score])));
    const echoDir = "/root/.local/joya-voiceprint/data/echo";
    if (fs.existsSync(echoDir)) {
      const files = fs.readdirSync(echoDir).filter((f) => /marin\.wav$/.test(f));
      for (const f of files.slice(0, 3)) await vp.learnTts("marin", to24(path.join(echoDir, f))).catch(() => {}), await sleep(0);
      // learnTts is rate-limited to one a minute: seed the rest straight from the service
      const echoes = [];
      for (const f of files.slice(3)) echoes.push(await vp.check(to24(path.join(echoDir, f)), { overVoice: true, voice: "marin" }));
      const through = echoes.filter((r) => r.verdict === "accept").length;
      check(`JOYA AI's real TTS voice over its playback (${echoes.length} lines): none accepted; ${echoes.filter((r) => r.verdict === "echo").length} flagged as echo`, through === 0, JSON.stringify(echoes.map((r) => [r.verdict, r.score, r.tts_score])));
    }
    const ms = mine.map((r) => r.ms).sort((a, b) => a - b);
    const sv = mine.map((r) => r.svc_ms).sort((a, b) => a - b);
    const med = (a) => a[Math.floor(a.length / 2)];
    // ~60 ms is the aim on a quiet box; the guard here is looser, the box runs other work.
    check(`the check takes ${med(ms)} ms (median round trip; ${med(sv)} ms in the service, 4 threads; p90 ${ms[Math.floor(ms.length * 0.9)]} ms) — under 100 ms`, med(ms) < 100, JSON.stringify(ms));
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-svc-"));
  const sock = path.join(sockDir, "fake.sock");
  const fake = await startFakeService(sock);
  try {
    decideTests();
    await library(sock);
    await relay(sock);
    pure();
    await routes(sock);
    await real();
  } catch (x) {
    failed++;
    console.log("  FAIL no exception\n" + x.stack);
  } finally {
    fake.close();
    mockServer.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
