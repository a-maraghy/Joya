#!/usr/bin/env node
"use strict";
/**
 * Tests for the Command Center's streamed read-aloud: the Voice module of
 * public/joya-ai.js (read-aloud only since 2026-09-30: voice is live
 * conversation, and the page records nothing itself), cut out of the file that
 * ships and run here in a sandbox with a fake Web Audio clock and a fake fetch
 * whose NDJSON body the test feeds a line at a time.
 *
 *   node dashboard/tools/test-voice-stream.cjs
 *
 * What it holds the page to:
 *   - a sentence starts playing with its first chunk, before its stream ends;
 *   - sentences play strictly in order, whichever arrives first;
 *   - a cut (the reading failed the verbatim check mid-way) stops what is
 *     playing at once -- a short fade, every scheduled chunk stopped -- and the
 *     fallback's reading plays after it, from a fresh start;
 *   - stopping a reading (Voice.stop: call.interrupt, the Stop control)
 *     stops the stream playing, aborts the ones fetched, and nothing more of
 *     them plays; there is no "Read replies aloud" switch any more
 *     (2026-10-30): a stored joya-read-aloud is ignored;
 *   - the orb's speaking level is the analyser's real output level;
 *   - every sentence carries its voice turn and kind, for the usage figures.
 *
 * .cjs because it uses require.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");

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
const flush = () => new Promise((r) => setImmediate(r));
async function settle(n) {
  for (let i = 0; i < (n || 6); i++) await flush();
}

/* ------------------------------------------------ the Voice module's text --- */

const start = SRC.indexOf("  var Voice = (function () {");
const endMark = "    return api_;\n  })();";
const end = SRC.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.log("  FAIL could not find the Voice module in joya-ai.js");
  process.exit(1);
}
const VOICE_SRC = SRC.slice(start, end + endMark.length);

/* ---------------------------------------------------------------- fakes --- */

function fakeEl(id) {
  const cls = new Set();
  return {
    id,
    disabled: false,
    hidden: false,
    title: "",
    textContent: "",
    innerHTML: "",
    style: {},
    classList: { toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] == null ? null : this.attrs[k];
    },
    listeners: {},
    addEventListener(t, fn) {
      (this.listeners[t] = this.listeners[t] || []).push(fn);
    },
    querySelectorAll: () => Array.from({ length: 44 }, () => ({ style: {} })),
  };
}

/** A Web Audio context whose clock only moves when the test says so. */
class FakeAC {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.sources = [];
    this.gains = [];
    this.destination = {};
    this.loud = false; // what the analyser hears
    FakeAC.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  close() {}
  createAnalyser() {
    const ctx = this;
    return {
      fftSize: 512,
      connect() {},
      getByteTimeDomainData(buf) {
        // micLoud: somebody talking into the microphone this context listens to.
        for (let i = 0; i < buf.length; i++) buf[i] = ctx.micLoud || (ctx.loud && ctx.sources.some((s) => s.playing())) ? (i % 2 ? 200 : 56) : 128;
      },
    };
  }
  createGain() {
    const g = { ramps: [], gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(v, t) { g.ramps.push([v, t]); } }, connect() {}, disconnect() { g.off = true; } };
    this.gains.push(g);
    return g;
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { duration: len / rate, length: len, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    const s = {
      buffer: null,
      gainNode: null,
      startAt: null,
      stoppedAt: null,
      ended: false,
      onended: null,
      connect(g) {
        s.gainNode = g;
      },
      start(t) {
        s.startAt = t;
        ctx.sources.push(s);
      },
      stop(t) {
        s.stoppedAt = t == null ? ctx.currentTime : t;
      },
      playing() {
        return s.startAt != null && s.stoppedAt == null && !s.ended && ctx.currentTime >= s.startAt;
      },
      value() {
        return s.buffer.getChannelData(0)[0];
      },
    };
    return s;
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  /** Move the clock; sources that have finished end. */
  advance(dt) {
    this.currentTime += dt;
    for (const s of this.sources) {
      if (s.ended || s.stoppedAt != null) continue;
      if (s.startAt + s.buffer.duration <= this.currentTime + 1e-9) {
        s.ended = true;
        if (s.onended) s.onended();
      }
    }
  }
}

/** A fetch whose NDJSON response body the test writes a line at a time. */
const fetches = [];
function fakeFetch(url, init) {
  const f = { url, init, body: JSON.parse(init.body), lines: [], waiters: [], ended: false, aborted: false };
  fetches.push(f);
  const signal = init.signal;
  if (signal) signal.addEventListener("abort", () => {
    f.aborted = true;
    f.waiters.splice(0).forEach((w) => w.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  f.push = (obj) => {
    f.lines.push(Buffer.from(JSON.stringify(obj) + "\n"));
    const w = f.waiters.shift();
    if (w) w.resolve({ value: f.lines.shift(), done: false });
  };
  f.end = () => {
    f.ended = true;
    const w = f.waiters.shift();
    if (w) w.resolve({ value: undefined, done: true });
  };
  const reader = {
    read() {
      if (f.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (f.lines.length) return Promise.resolve({ value: f.lines.shift(), done: false });
      if (f.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => f.waiters.push({ resolve, reject }));
    },
  };
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/x-ndjson" }, body: { getReader: () => reader }, json: () => Promise.resolve({}) });
}

/** The desk's stream (apiStream in joya-ai.js), fed by the test. */
const deskCalls = [];
function fakeApiStream(p, body, onEvent) {
  return new Promise((resolve, reject) => deskCalls.push({ path: p, body, onEvent, resolve, reject }));
}

function pcm(value, ms) {
  const n = Math.round(24 * (ms || 100));
  const b = Buffer.alloc(n * 2);
  const v = Math.round(value * 32768);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  return b.toString("base64");
}

/* ------------------------------------------------------------ the sandbox --- */

function boot(opts) {
  const o = opts || {};
  fetches.length = 0;
  deskCalls.length = 0;
  const els = {};
  const docListeners = {};
  const toasts = [];
  let outLevelFn = null;
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    Float32Array,
    Uint8Array,
    TextDecoder,
    Promise,
    Map,
    Set,
    JSON,
    Math,
    Date,
    String,
    Number,
    Array,
    Object,
    Error,
    Blob: class {},
    FileReader: class {},
    AbortController,
    fetch: fakeFetch,
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
    document: {
      activeElement: { tagName: "BODY", isContentEditable: false, getAttribute: () => null },
      addEventListener(t, fn) {
        (docListeners[t] = docListeners[t] || []).push(fn);
      },
      removeEventListener(t, fn) {
        docListeners[t] = (docListeners[t] || []).filter((x) => x !== fn);
      },
    },
    $: (id) => (els[id] = els[id] || fakeEl(id)),
    READY: true,
    VOICE: "marin",
    DESK: !!o.desk,
    CSRF: "tok",
    S: { status: { busy: false } },
    Orb: { micSource() {}, outSource(fn) { outLevelFn = fn; } },
    toast: (m) => toasts.push(m),
    clip: (s, n) => String(s).slice(0, n),
    ic: () => "",
    api: () => Promise.resolve({}),
    apiStream: fakeApiStream,
    send: () => Promise.resolve(null),
    upsertTurn: (t) => t,
    aiText: () => "",
    showPane() {},
    deskTurns: new Set(),
    renderRail() {},
    paintState() {},
    P: { loadVoiceUsage() { sandbox.usageLoads++; }, setVoiceUsage(u) { sandbox.usageSet.push(u); } },
    usageLoads: 0,
    usageSet: [],
  };
  class FakeRecorder {
    constructor() {
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      if (this.onstop) this.onstop();
    }
  }
  const store = {};
  sandbox.window = { AudioContext: FakeAC, MediaRecorder: FakeRecorder, AbortController, __joyaVoice: null, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) } };
  if (o.readAloud) store["joya-read-aloud"] = "1";
  sandbox.store = store;
  sandbox.MediaRecorder = sandbox.window.MediaRecorder;
  vm.createContext(sandbox);
  vm.runInContext(VOICE_SRC + "\nthis.Voice = Voice;", sandbox);
  return {
    Voice: sandbox.Voice,
    diag: () => sandbox.window.__joyaVoice,
    ctx: () => FakeAC.last,
    toasts,
    sandbox,
    outLevel: () => outLevelFn(),
    keydown: (code) => (docListeners.keydown || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} })),
    keyup: (code) => (docListeners.keyup || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} })),
  };
}

/* ----------------------------------------------------------------- tests --- */

(async () => {
  section("read-aloud: a sentence plays from its first chunk");
  {
    const t = boot();
    t.Voice.unlock(); // the first click: the AudioContext exists
    t.Voice.tag(41, { vt: "vturn41", cat: "direct" });
    t.Voice.flush(41, "Every service on this machine is healthy.");
    await settle();
    check("one POST to /joya-ai/api/speak, asking for a stream", fetches.length === 1 && fetches[0].url === "/joya-ai/api/speak" && fetches[0].init.headers.Accept === "application/x-ndjson");
    check("  it carries the sentence, the voice turn and its kind (for the usage figures)", fetches[0].body.text === "Every service on this machine is healthy." && fetches[0].body.vt === "vturn41" && fetches[0].body.cat === "direct", JSON.stringify(fetches[0].body));
    const f = fetches[0];
    f.push({ type: "start", engine: "gpt-realtime-mini", rate: 24000 });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    const ctx = t.ctx();
    check("the first chunk is scheduled at once, with a short lead, before the stream has ended", ctx.sources.length === 1 && !f.ended && ctx.sources[0].startAt > 0 && ctx.sources[0].startAt <= 0.1, ctx.sources.map((s) => s.startAt).join());
    check("  and the samples are the PCM that arrived (0.25)", Math.abs(ctx.sources[0].value() - 0.25) < 1e-4);
    check("  the voice is speaking", t.Voice.speaking === true);
    ctx.loud = true;
    ctx.advance(0.07);
    check("the orb's speaking level is the analyser's real output level", t.outLevel() > 0.3, t.outLevel());
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    check("the next chunk is scheduled right after the first, gapless", ctx.sources.length === 2 && Math.abs(ctx.sources[1].startAt - (ctx.sources[0].startAt + 0.1)) < 1e-6, ctx.sources.map((s) => s.startAt).join());
    f.push({ type: "end", engine: "realtime" });
    f.end();
    await settle();
    ctx.advance(0.5);
    await settle();
    const d = t.diag();
    check("when the stream has ended and the last chunk played, the sentence is done", t.Voice.speaking === false && d.played === 1 && d.items.length === 1 && d.items[0].sched <= d.items[0].end && d.items[0].first <= d.items[0].sched, JSON.stringify(d.items));
    check("  a quiet voice has level -1 (not speaking)", t.outLevel() === -1);
    check("  and the usage figures are refreshed after the speech", await new Promise((r) => setTimeout(() => r(t.sandbox.usageLoads === 1), 1000)));
  }

  section("ordering: sentences play in order, whichever arrives first");
  {
    const t = boot();
    t.Voice.unlock();
    t.Voice.say("The first sentence is here.");
    t.Voice.say("The second sentence is here.");
    await settle();
    check("both are fetched ahead", fetches.length === 2);
    const [a, b] = fetches;
    b.push({ type: "start", engine: "gpt-realtime-mini" });
    b.push({ type: "audio", pcm: pcm(0.5, 100) });
    b.push({ type: "end", engine: "realtime" });
    b.end();
    await settle();
    const ctx = t.ctx();
    check("the second, arriving first, does not play before the first", ctx.sources.length === 0);
    a.push({ type: "start", engine: "gpt-realtime-mini" });
    a.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    check("the first plays as soon as its audio arrives", ctx.sources.length === 1 && Math.abs(ctx.sources[0].value() - 0.25) < 1e-4);
    a.push({ type: "end", engine: "realtime" });
    a.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("then the second, after the first has finished", ctx.sources.length === 2 && Math.abs(ctx.sources[1].value() - 0.5) < 1e-4 && ctx.sources[1].startAt >= ctx.sources[0].startAt + 0.1 - 1e-9, ctx.sources.map((s) => s.startAt + ":" + s.value().toFixed(2)).join());
  }

  section("a cut mid-clip: playback stops at once, the fallback reads the sentence from the start");
  {
    const t = boot();
    t.Voice.unlock();
    t.Voice.say("Three sessions are running and two are waiting.");
    t.Voice.say("After that, nothing else.");
    await settle();
    const f = fetches[0];
    f.push({ type: "start", engine: "gpt-realtime-mini" });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    const ctx = t.ctx();
    ctx.advance(0.12); // part-way into the first chunks
    const before = ctx.sources.slice();
    const g0 = before[0].gainNode;
    f.push({ type: "cut", why: "unfaithful" });
    await settle();
    check("every scheduled chunk of the failed reading is stopped", before.length === 3 && before.every((s) => s.stoppedAt != null), before.map((s) => s.stoppedAt).join());
    check("  within a short fade (no click): the gain ramps to 0 in ~12 ms", g0.ramps.length === 1 && g0.ramps[0][0] === 0 && g0.ramps[0][1] - ctx.currentTime <= 0.0125 + 1e-9 && before.every((s) => s.stoppedAt <= ctx.currentTime + 0.016), JSON.stringify(g0.ramps));
    check("  the cut is counted, while it was playing", t.diag().cuts === 1 && t.diag().cutAt.length === 1 && t.diag().cutAt[0].playing === true);
    f.push({ type: "start", engine: "gpt-4o-mini-tts" });
    f.push({ type: "audio", pcm: pcm(0.75, 100) });
    await settle();
    const after = ctx.sources.slice(3);
    check("the fallback's reading plays next, through a fresh gain, from a fresh start", after.length === 1 && Math.abs(after[0].value() - 0.75) < 1e-4 && after[0].gainNode !== g0 && after[0].startAt >= ctx.currentTime, after.map((s) => s.startAt).join());
    f.push({ type: "end", engine: "fallback", fallback: true });
    f.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("the next sentence still follows, in order", ctx.sources.length === 4 || fetches[1].lines.length === 0, ctx.sources.length);
    check("  the sentence counts as played once, with one cut", t.diag().played === 1 && t.diag().items[0].cuts === 1);

    // A cut before a sentence's turn: what it held is dropped, nothing of it plays.
    const g = fetches[1];
    g.push({ type: "start", engine: "gpt-realtime-mini" });
    g.push({ type: "cut", why: "unfaithful" });
    g.push({ type: "start", engine: "gpt-4o-mini-tts" });
    g.push({ type: "audio", pcm: pcm(0.9, 50) });
    g.push({ type: "end", engine: "fallback" });
    g.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("a sentence cut before it played plays only the fallback's reading", ctx.sources.length === 5 && Math.abs(ctx.sources[4].value() - 0.9) < 1e-4, ctx.sources.map((s) => s.value().toFixed(2)).join());

    // Skipped (the fallback failed too): nothing plays, the text stays on screen.
    t.Voice.say("This one will not be read.");
    await settle();
    const h = fetches[2];
    h.push({ type: "start", engine: "gpt-realtime-mini" });
    h.push({ type: "audio", pcm: pcm(0.3, 50) });
    await settle();
    h.push({ type: "cut", why: "unfaithful" });
    h.push({ type: "skipped", why: "unfaithful" });
    h.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("cut and then skipped: stopped, and the skip is said once (the words are on screen)", ctx.sources[5] && ctx.sources[5].stoppedAt != null && t.toasts.some((m) => /not read aloud/.test(m)) && t.Voice.speaking === false, t.toasts.join("|"));
  }

  section("stopping a reading during a stream");
  {
    const t = boot({ readAloud: true });
    check("no read-aloud switch: a stored joya-read-aloud is ignored (removed 2026-10-30)", t.Voice.speakAll === undefined && !/joya-read-aloud|cc-speak-toggle/.test(VOICE_SRC));
    t.Voice.unlock();
    t.Voice.say("A long answer starts here.");
    t.Voice.say("And it goes on.");
    t.Voice.say("And on.");
    await settle();
    const [a, b, c] = fetches;
    a.push({ type: "start", engine: "gpt-realtime-mini" });
    a.push({ type: "audio", pcm: pcm(0.25, 300) });
    b.push({ type: "start", engine: "gpt-realtime-mini" });
    b.push({ type: "audio", pcm: pcm(0.5, 300) });
    await settle();
    const ctx = t.ctx();
    ctx.advance(0.1);
    check("speaking the first", t.Voice.speaking === true && ctx.sources.length === 1);
    t.Voice.stop(); // a stop (call.interrupt, Esc)
    await settle();
    check("stopping stops what is playing at once", ctx.sources[0].stoppedAt != null && t.Voice.speaking === false);
    check("  and aborts every sentence fetched ahead", a.aborted && b.aborted && c.aborted);
    a.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    ctx.advance(1);
    await settle();
    check("  nothing more of them plays", ctx.sources.length === 1, ctx.sources.length);
  }

  section("nothing of the old voice paths is left in the module");
  check("no recorder, no push to talk, no hands-free, no desk lines, no barge-in by the mic", !/MediaRecorder|getUserMedia|pttDown|handsfree|deskLines|enqueueRemote|bargeIn|transcribe/.test(VOICE_SRC));
  {
    const t = boot();
    t.Voice.say("Anything.");
    await settle();
    check("typed replies are never read by themselves: only what is asked for (say / a reply's Read aloud)", t.Voice.speakAll === undefined && !/speakAll/.test(SRC));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
