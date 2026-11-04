#!/usr/bin/env node
"use strict";
/**
 * JOYA AI's sound identity (2026-10-20): public/joya-sound.js and its hooks.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-sound-identity.cjs [SHOTS_DIR]
 *
 * Pure parts (the prefs and their check, quiet hours, the recipes and one voice per role, the limiter:
 * merging, the gap, cooldowns, the budget, stale events), an engine with a fake clock / audio / storage
 * (unlock by a gesture only, the desktop probe, the browser switch, off, quiet hours, the call / TTS
 * mute -- also for a sound already waiting --, do-not-disturb, two tabs), the offline render
 * (tools/make-sound-identity.cjs), the hooks in the page's files, then a scratch copy of the server
 * (POST /joya-ai/api/prefs/sound: CSRF, validation, audit, storage; the page and Settings carry the
 * prefs) and headless Chromium (silent before a gesture, a session needing you chirps in its role's
 * voice once switched on, Settings saves the switch and the slider; a screenshot of the Sounds group
 * into SHOTS_DIR when given).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : "")); }
}
const section = (t) => console.log("\n" + t);
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const M = require(path.join(ROOT, "public", "joya-sound.js"));
const R = require("./make-sound-identity.cjs");
const SHOTS = process.argv[2] || "";

/* ---- fakes: a clock with timers, an AudioContext, storage, a document */
function fakeWorld(o) {
  o = o || {};
  const w = { t: o.t || Date.UTC(2026, 9, 20, 10, 0, 0), timers: [], hour: o.hour == null ? 12 : o.hour, ctxs: [], store: o.store || new Map(), listeners: {} };
  w.now = () => w.t;
  w.date = () => { const d = new Date(2026, 9, 20, w.hour, 30, 0); return d; };
  w.setTimeout = (f, ms) => { const h = { at: w.t + Math.max(0, ms), f }; w.timers.push(h); return h; };
  w.clearTimeout = (h) => { w.timers = w.timers.filter((x) => x !== h); };
  w.advance = (ms) => {
    const end = w.t + ms;
    for (;;) {
      w.timers.sort((a, b) => a.at - b.at);
      const h = w.timers[0];
      if (!h || h.at > end) break;
      w.timers.shift(); w.t = h.at; h.f();
    }
    w.t = end;
  };
  const param = () => ({ value: 0, calls: [], setValueAtTime(v) { this.calls.push(["set", v]); }, linearRampToValueAtTime(v) { this.calls.push(["lin", v]); }, exponentialRampToValueAtTime(v) { this.calls.push(["exp", v]); } });
  const node = (extra) => Object.assign({ connect() {}, disconnect() {} }, extra);
  w.AudioContext = function () {
    const c = this;
    c.state = o.running ? "running" : "suspended"; c.currentTime = 0; c.destination = node({}); c.oscs = []; c.gains = []; c.ls = [];
    c.resume = () => { c.state = "running"; c.ls.forEach((f) => f()); return Promise.resolve(); };
    c.addEventListener = (n, f) => { if (n === "statechange") c.ls.push(f); };
    c.createOscillator = () => { const x = node({ type: "sine", frequency: param(), started: 0, start() { this.started++; }, stop() {} }); c.oscs.push(x); return x; };
    c.createGain = () => { const g = node({ gain: param() }); c.gains.push(g); return g; };
    c.createBiquadFilter = () => node({ type: "", frequency: param() });
    w.ctxs.push(c);
  };
  w.storage = { getItem: (k) => (w.store.has(k) ? w.store.get(k) : null), setItem: (k, v) => w.store.set(k, String(v)) };
  w.doc = {
    addEventListener: (n, f) => { (w.listeners[n] = w.listeners[n] || []).push(f); },
    removeEventListener: (n, f) => { w.listeners[n] = (w.listeners[n] || []).filter((x) => x !== f); },
    fire: (n) => (w.listeners[n] || []).slice().forEach((f) => f({ type: n })),
  };
  w.engine = (extra) => M.create(Object.assign({ now: w.now, date: w.date, setTimeout: w.setTimeout, clearTimeout: w.clearTimeout, AudioContext: w.AudioContext, storage: w.storage, doc: w.doc }, extra || {}));
  w.played = (e) => e.log().filter((x) => x.why === "played").map((x) => x.name + (x.role ? ":" + x.role : ""));
  return w;
}
const tick = () => new Promise((r) => setImmediate(r));
/** An engine ready to play: a desktop host (no browser switch needed), unlocked by a click. */
async function ready(w, prefs) {
  const e = w.engine();
  e.setHost({ desktop: true });
  if (prefs) e.setPrefs(prefs);
  w.doc.fire("pointerdown");
  await tick();
  return e;
}

(async () => {
  section("prefs (users.joya_sound) and their check");
  check("defaults: on, 30 %, quiet hours on, 23:00-07:00", JSON.stringify(M.normSoundPrefs("")) === '{"on":true,"vol":30,"quiet":true,"from":"23:00","to":"07:00"}');
  check("garbage reads as the defaults; partly good keeps the good part", JSON.stringify(M.normSoundPrefs("{nope")) === JSON.stringify(M.DEFAULTS) && M.normSoundPrefs('{"vol":80,"from":"25:00","on":"yes"}').vol === 80 && M.normSoundPrefs('{"vol":80,"from":"25:00"}').from === "23:00" && M.normSoundPrefs('{"on":"yes"}').on === true);
  check("an edit: any of on, vol, quiet, from, to", M.checkSoundEdit({ vol: 55 }).ok && M.checkSoundEdit({ on: false, quiet: false, from: "22:30", to: "06:45" }).ok);
  const bad = [null, [], {}, { on: "no" }, { vol: 101 }, { vol: -1 }, { vol: 12.5 }, { vol: "50" }, { quiet: 1 }, { from: "7:00" }, { to: "24:00" }, { from: "<b>" }];
  check("refused: nothing, wrong types, a volume outside 0-100 or not whole, a time not HH:MM", bad.every((b) => !M.checkSoundEdit(b).ok), JSON.stringify(bad.filter((b) => M.checkSoundEdit(b).ok)));
  const ap = M.applySoundEdit('{"vol":70,"quiet":false}', { on: false });
  check("an edit merges into what is stored", ap.on === false && ap.vol === 70 && ap.quiet === false && ap.from === "23:00");
  check("the audit line", M.soundPrefsLine("") === "on · 30 % · quiet 23:00–07:00" && M.soundPrefsLine({ on: false, quiet: false }) === "off · 30 % · no quiet hours");

  section("quiet hours");
  const at = (h, m) => new Date(2026, 9, 20, h, m || 0);
  check("23:00-07:00 wraps midnight: 23:00, 02:00, 06:59 quiet; 07:00, 12:00, 22:59 not", [at(23), at(2), at(6, 59)].every((d) => M.inQuietHours(d, "23:00", "07:00")) && [at(7), at(12), at(22, 59)].every((d) => !M.inQuietHours(d, "23:00", "07:00")));
  check("a daytime window (13:00-14:30) and an empty one (09:00-09:00)", M.inQuietHours(at(13, 15), "13:00", "14:30") && !M.inQuietHours(at(14, 30), "13:00", "14:30") && !M.inQuietHours(at(9), "09:00", "09:00"));

  section("the sounds: five chirps x six roles, two key sounds");
  const roles = Object.keys(M.ROLES);
  check("the roles: JOYA AI itself (core) and every role of cc-logic's BOT_ROLE_RULES", roles.join() === "core,hired,planning,erp,builder,other" && (() => { const L = require(path.join(ROOT, "public", "cc-logic.js")); return L.BOT_ROLE_RULES.map((r) => r.role).concat(L.BOT_ROLE_DEFAULT.role).every((r) => roles.includes(r)); })());
  check("every chirp has a recipe for every role; short (at most 0.5 s)", M.CHIRPS.every((n) => roles.every((r) => { const x = M.recipe(n, r); return x && x.length && M.recipeLength(x) <= 0.5; })));
  check("the key sounds: the same for every role; the approval chime a soft bell (FM), the job chime three rising notes", M.KEYS.every((n) => JSON.stringify(M.recipe(n, "erp")) === JSON.stringify(M.recipe(n, "core"))) && M.recipe("approval").every((n) => n.fm && n.fm.decay) && M.recipe("job").length === 3 && M.recipe("job")[2].f0 > M.recipe("job")[0].f0 && M.recipeLength(M.recipe("approval")) <= 1.6);
  const sig = (n, r) => { const x = M.recipe(n, r); return x[0].f0.toFixed(1) + x[0].wave + (x[0].lp || 0) + (x[0].fm ? "fm" : "") + (x[0].harm || 0); };
  check("each role sounds different (pitch and timbre) for every chirp", M.CHIRPS.every((n) => new Set(roles.map((r) => sig(n, r))).size === roles.length));
  check("an unknown role is 'other', none is JOYA AI's own; an unknown sound has no recipe", sig("done", "chef") === sig("done", "other") && sig("done", "") === sig("done", "core") && M.recipe("boom") === null);
  check("the chirps match the reactions: wake and done rise, error falls, needs ends on a question", M.recipe("wake").slice(-1)[0].f1 > M.recipe("wake")[0].f0 && M.recipe("done")[1].f1 > M.recipe("done")[0].f0 && M.recipe("error").slice(-1)[0].f1 < M.recipe("error")[0].f0 && M.recipe("needs").slice(-1)[0].f1 > M.recipe("needs").slice(-1)[0].f0);
  check("the volume curve: 0 silent, 30 % quiet (under a sixth of full), 100 % = 0.6", M.gainFor(0) === 0 && M.gainFor(30) / M.gainFor(100) < 1 / 6 && Math.abs(M.gainFor(100) - 0.6) < 1e-9);

  section("the limiter: never stacking");
  {
    const L = new M.Limiter();
    check("a first event waits for the merge window", L.offer({ name: "think", role: "core" }, 1000) === "held" && L.due() === 1000 + M.MERGE_MS && L.flush(1000 + M.MERGE_MS - 1) === null);
    check("events in the window merge: the most important wins (needs over think), a less important one is merged", L.offer({ name: "needs", role: "erp" }, 1100) === "held" && L.offer({ name: "done", role: "erp" }, 1200) === "merged");
    const ev = L.flush(1000 + M.MERGE_MS);
    check("one sound comes out of the burst", ev && ev.name === "needs" && ev.role === "erp" && L.flush(5000) === null);
    L.played(ev, 1350);
    check("the next one waits at least the gap after the last sound", L.offer({ name: "done", role: "core" }, 1400) === "held" && L.due() === 1350 + M.GAP_MS);
    check("the same sound and role within its cooldown is dropped; another role is not", (L.flush(1350 + M.GAP_MS), L.offer({ name: "needs", role: "erp" }, 4000)) === "cooldown" && L.offer({ name: "needs", role: "planning" }, 4000) === "held");
    const L2 = new M.Limiter();
    L2.offer({ name: "approval" }, 0);
    check("a sound held longer than MAX_AGE is dropped (it says nothing any more)", L2.flush(M.MAX_AGE_MS + 10) === null);
    const L3 = new M.Limiter();
    let t = 0, n = 0;
    for (let i = 0; i < 20; i++) { const names = ["think", "done", "needs", "error", "approval", "job", "wake"]; const e = { name: names[i % 7], role: ["core", "erp", "hired"][i % 3] }; if (L3.offer(e, t) === "held") { const f = L3.flush(L3.due()); if (f) { L3.played(f, L3.due() || t); n++; } } t += 2000; }
    check("at most " + M.BUDGET + " a minute", n <= M.BUDGET + 1 && L3.offer({ name: "error", role: "builder" }, t) === "rate", n);
  }

  section("the engine (fake clock and audio)");
  {
    let w = fakeWorld(); let e = w.engine();
    e.setHost({ desktop: true });
    check("nothing before a gesture (autoplay rules): locked; the desktop host's probe context stays suspended", e.play("done", { role: "core" }).why === "locked" && w.ctxs.length === 1 && w.ctxs[0].state === "suspended" && !e.unlocked());
    w.doc.fire("keydown"); await tick();
    check("a key press unlocks it (the context resumed), and the gesture listeners are gone", e.unlocked() && w.ctxs.length === 1 && w.ctxs[0].state === "running" && !(w.listeners.keydown || []).length && !(w.listeners.pointerdown || []).length);
    const r = e.play("done", { role: "planning" });
    check("then a sound is held for the merge window, not played at once", r.ok && r.why === "held" && w.ctxs[0].oscs.length === 0);
    w.advance(M.MERGE_MS + 5);
    check("...and plays: oscillators started, through a master gain at the volume (30 %)", w.ctxs[0].oscs.length >= 2 && w.ctxs[0].oscs.every((o) => o.started === 1) && Math.abs(w.ctxs[0].gains[0].gain.value - M.gainFor(30)) < 1e-9 && w.played(e).join() === "done:planning");
    e.play("think", { role: "core" }); e.play("needs", { role: "erp" }); e.play("think", { role: "hired" });
    w.advance(M.GAP_MS + 100);
    check("a burst of three makes one sound (needs)", w.played(e).join() === "done:planning,needs:erp", w.played(e).join());
    e.play("approval"); w.advance(200); e.play("job"); w.advance(M.GAP_MS + 500);
    check("the approval chime and then, a gap later, nothing piled up (the job merged into the approval)", w.played(e).slice(-1)[0] === "approval" && w.played(e).length === 3, w.played(e).join());

    w = fakeWorld(); e = w.engine(); w.doc.fire("pointerdown"); await tick();
    check("a plain browser: silent until switched on there", e.play("done").why === "browser");
    e.setBrowserOn(true);
    check("switched on in this browser (localStorage): it plays", e.browserOn() && w.store.get("joya-sound-browser") === "1" && e.play("done").why === "held");
    e.setPrefs({ on: false });
    check("the person's off switch silences it everywhere", e.play("error").why === "off" && (e.setHost({ desktop: true }), e.play("error").why === "off"));

    w = fakeWorld({ hour: 23 }); e = await ready(w);
    check("quiet hours (default 23:00-07:00): silent at 23:30", e.play("approval").why === "quiet");
    e.setPrefs({ quiet: false });
    check("quiet hours off: it plays at 23:30", e.play("approval").why === "held");
    e.setPrefs({ quiet: true, from: "13:00", to: "14:00" }); w.hour = 13;
    check("custom quiet hours (13:00-14:00) at 13:30: silent", e.play("approval").why === "quiet");

    w = fakeWorld(); e = await ready(w);
    let call = false, speaking = false;
    e.mutedBy(() => (call ? "call" : ""));
    e.mutedBy(() => (speaking ? "speaking" : ""));
    call = true;
    check("during a live call: silent", e.play("needs", { role: "erp" }).why === "call");
    call = false; speaking = true;
    check("while the voice (TTS) speaks: silent", e.play("needs", { role: "erp" }).why === "speaking");
    speaking = false;
    check("after both: it plays", e.play("needs", { role: "erp" }).why === "held");
    call = true; w.advance(M.MERGE_MS + 10);
    check("a call that starts while a sound waits in the merge window: it is dropped, not played", w.played(e).length === 0 && e.log().slice(-1)[0].why === "call");
    call = false;
    e.setHost({ dnd: true });
    check("the desktop app's do-not-disturb (when it sends it): silent", e.play("approval").why === "dnd");
    e.setHost({ dnd: false });

    w = fakeWorld({ running: true }); e = w.engine();
    e.setHost({ desktop: true });
    check("the desktop app: a context the host lets start 'running' counts as unlocked (no gesture needed there)", e.unlocked());
    w = fakeWorld({ running: true }); e = w.engine();
    check("a plain browser never makes a context before a gesture", !e.unlocked() && w.ctxs.length === 0);

    const shared = new Map();
    const wa = fakeWorld({ store: shared }), wb = fakeWorld({ store: shared });
    const A = await ready(wa), B = await ready(wb);
    A.play("done", { role: "core" }); B.play("done", { role: "core" });
    wa.advance(M.MERGE_MS + 5); wb.t = wa.t; wb.advance(10);
    check("two tabs of one browser: the moment plays once (the other sees it in localStorage)", wa.played(A).length + wb.played(B).length === 1, [wa.played(A), wb.played(B)].join("|"));
    check("an unknown sound: refused", A.play("boom").why === "unknown");
  }

  section("the offline render (tools/make-sound-identity.cjs)");
  {
    const all = [];
    for (const n of M.CHIRPS) for (const r of roles) all.push([n, r, R.renderPCM(n, r, 100)]);
    for (const n of M.KEYS) all.push([n, "", R.renderPCM(n, "", 100)]);
    check("every sound renders, never clips at 100 %, and is not silent", all.every(([, , p]) => { const s = R.stats(p); return s.peakDb < -3 && s.peakDb > -24; }), JSON.stringify(all.map(([n, r, p]) => n + r + R.stats(p).peakDb)));
    check("at the default volume (30 %) the same sound is about 20 dB quieter", (() => { const a = R.stats(R.renderPCM("approval", "", 100)).peakDb, b = R.stats(R.renderPCM("approval", "", 30)).peakDb; return a - b > 18 && a - b < 23; })());
    check("starts and ends at silence (no click)", all.every(([, , p]) => Math.abs(p[0]) < 1e-3 && Math.abs(p[p.length - 1]) < 1e-3));
    const pc = (n) => roles.map((r) => R.pitchOf(R.renderPCM(n, r, 100)));
    check("the roles are told apart by ear too: rendered, every role's chirp is a different waveform", M.CHIRPS.every((n) => new Set(roles.map((r) => Buffer.from(R.renderPCM(n, r, 100).buffer).toString("base64").slice(2000, 2400))).size === roles.length), JSON.stringify(pc("done")));
    const wv = R.wav(R.renderPCM("think", "core", 30));
    check("a WAV: RIFF, 48 kHz mono 16-bit", wv.toString("ascii", 0, 4) === "RIFF" && wv.readUInt32LE(24) === 48000 && wv.readUInt16LE(22) === 1 && wv.readUInt16LE(34) === 16);
  }

  section("the hooks");
  {
    const map = read("public/cc-map.js"), bot = read("public/joya-core-bot.js"), cc = read("public/joya-ai.js"), dk = read("public/joya-desktop.js"), views = read("lib/views-joyaai.js"), snd = read("public/joya-sound.js");
    check("cc-map: a session waiting -> needs, working -> idle -> done, idle -> working -> think, each in its role's voice; every core", /sound\("needs", s\.role\)/.test(map) && /sound\("done", s\.role\)/.test(map) && /sound\("think", s\.role\)/.test(map) && !/if \(!was \|\| !core\.react\) return;/.test(map));
    check("cc-map: JOYA AI thinking -> think, a long turn done -> the job chime (with the grin), going offline -> error, the bot waking -> wake", /sound\("think", "core"\)/.test(map) && /if \(long\) sound\("job", "core"\)/.test(map) && /if \(!!on && !offline\) sound\("error", "core"\)/.test(map) && /onWake: function \(\) \{ sound\("wake", "core"\); \}/.test(map));
    check("joya-core-bot: a dozing bot that wakes tells the page (opts.onWake), with its wake reaction", /react\("wake"\); if \(opts\.onWake\)/.test(bot));
    check("joya-ai: sessions carry their role; an approval waiting chimes; a delegation done -> job, failed -> error; a turn ending in an error -> error", /role: sessHead\(s\)\.role/.test(cc) && /Voice\.say\("I need your approval before I go on\."\);\n\s+sound\("approval"\);/.test(cc) && /d\.status === "done"\) sound\("job"\)/.test(cc) && /d\.status === "failed"\) sound\("error"/.test(cc) && /cur\.status === "error"\) sound\("error", "core"\)/.test(cc));
    check("joya-ai: muted during a live call or while the voice speaks; prefs from #cc data-sound; the desktop host; Settings changes by a storage event", /if \(liveActive\(\)\) return "call";/.test(cc) && /Voice\.speaking\) return "speaking";/.test(cc) && /Snd\.setPrefs\(root\.getAttribute\("data-sound"\)/.test(cc) && /Snd\.setHost\(\{ desktop: DESKTOP \}\)/.test(cc) && /e\.key !== "joya-sound"/.test(cc));
    check("joya-desktop: the app's dnd / focusAssist reach the sounds when it sends them", /function soundHost\(p\)/.test(dk) && /setHost\(\{ dnd: !!p\.dnd \|\| !!p\.focusAssist \}\)/.test(dk) && (dk.match(/soundHost\(p\);/g) || []).length === 2);
    check("the page loads joya-sound.js before cc-map.js (web and desktop)", (views.match(/"cc-logic\.js", "joya-sound\.js", "joya-core-d\.js", "joya-core-bot\.js", "cc-family\.js", "cc-map\.js"/g) || []).length === 2);
    check("joya-sound.js: CSP-safe (no eval, no inline style, no URL), JoyaSound.play exposed for the other builds", !/\beval\(|new Function|\.style\.|setAttribute\("style"|https?:\/\//.test(snd.replace(/\/\*[\s\S]*?\*\//g, "")) && /window\.JoyaSound = eng/.test(snd) && /play: function \(name, o\)/.test(snd));
  }

  /* ------------------------------------------------------------- over HTTP --- */
  section("over HTTP (a scratch copy)");
  const s = await scratch.startScratch({});
  const db = require(path.join(ROOT, "lib", "db.js"));
  let browser = null;
  try {
    await s.makeUser("sndadmin", "administrator");
    await s.makeUser("sndviewer", "viewer");
    const A = await s.signIn("sndadmin");
    const V = await s.signIn("sndviewer");
    let r = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    const tok = s.csrfOf(r.body);
    check("never set: the page carries the defaults on #cc", /data-sound="\{&quot;on&quot;:true,&quot;vol&quot;:30,&quot;quiet&quot;:true,&quot;from&quot;:&quot;23:00&quot;,&quot;to&quot;:&quot;07:00&quot;\}"/.test(r.body) && /joya-sound\.js/.test(r.body));
    const post = (who, body, token) => s.req("POST", "/joya-ai/api/prefs/sound", { cookie: who.cookie, headers: Object.assign({ Accept: "application/json" }, token ? { "X-CSRF-Token": token } : {}), body });
    r = await post(A, { vol: 50 });
    check("without the CSRF token: refused (403)", r.status === 403, r.status);
    r = await post(A, { vol: 150 }, tok);
    check("a volume over 100: refused (400), nothing saved", r.status === 400 && /0 to 100/.test(r.body) && db.getUserByName("sndadmin").joya_sound === "", r.status + " " + r.body);
    r = await post(A, { from: "7am" }, tok);
    check("a time that is not HH:MM: refused (400)", r.status === 400, r.status);
    r = await post(A, { vol: 55 }, tok);
    check("the volume: saved, the rest stays the defaults", r.status === 200 && JSON.parse(r.body).sound.vol === 55 && JSON.parse(db.getUserByName("sndadmin").joya_sound).vol === 55 && JSON.parse(db.getUserByName("sndadmin").joya_sound).on === true, r.body);
    r = await post(A, { on: false, from: "22:00", to: "06:30" }, tok);
    check("off and new quiet hours: merged into what is stored", r.status === 200 && JSON.stringify(JSON.parse(db.getUserByName("sndadmin").joya_sound)) === '{"on":false,"vol":55,"quiet":true,"from":"22:00","to":"06:30"}' && JSON.parse(r.body).line === "off · 55 % · quiet 22:00–06:30", r.body);
    const rows = db.recentLogins(50).filter((x) => x.outcome === "account" && /JOYA AI sounds/.test(x.detail || ""));
    check("audited: from what to what", rows.some((x) => x.username === "sndadmin" && /JOYA AI sounds on · 30 % · quiet 23:00–07:00 -> on · 55 %/.test(x.detail)) && rows.some((x) => /-> off · 55 % · quiet 22:00–06:30/.test(x.detail)), JSON.stringify(rows.map((x) => x.detail)));
    const vt = s.csrfOf((await s.req("GET", "/account", { cookie: V.cookie })).body);
    r = await post(V, { vol: 10 }, vt);
    check("a viewer (no JOYA AI) cannot set it (403)", r.status === 403 && db.getUserByName("sndviewer").joya_sound === "", r.status);
    r = await s.req("POST", "/joya-ai/api/prefs/sound", { headers: { Accept: "application/json" }, body: { vol: 10 } });
    check("signed out: 401", r.status === 401, r.status);
    r = await s.req("GET", "/joya-ai/settings/appearance", { cookie: A.cookie });
    check("Settings > Appearance: a Sounds group with the saved values, this browser's switch, Listen buttons and its scripts", r.status === 200 && /id="joya-sound-set"/.test(r.body) && /data-snd="vol"[^>]*>|value="55" data-snd="vol"/.test(r.body) && /value="22:00" data-snd="from"/.test(r.body) && /data-snd="browser"/.test(r.body) && /data-snd-try="approval"/.test(r.body) && /joya-sound-settings\.js/.test(r.body), r.status);
    await post(A, { on: true, from: "23:00", to: "07:00", vol: 30 }, tok);

    /* ------------------------------------------------------------- in the browser --- */
    let chromium = null;
    try { chromium = require(process.env.PLAYWRIGHT || "playwright").chromium; } catch (e) { chromium = null; }
    if (!chromium) console.log("\n(browser part skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)");
    else {
      section("in the browser");
      browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=user-gesture-required"] });
      const errs = [];
      async function open(url, theme) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme || "dark", extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(e.message));
        page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
        await page.goto("http://127.0.0.1:" + s.port + url, { waitUntil: "load" });
        return { ctx, page };
      }
      {
        const { ctx, page } = await open("/joya-ai");
        await page.waitForFunction(() => window.__joyaCC && window.JoyaSound, null, { timeout: 15000 });
        const pre = await page.evaluate(() => ({ prefs: window.JoyaSound.prefs(), host: window.JoyaSound.host(), why: window.JoyaSound.silentWhy(), unl: window.JoyaSound.unlocked() }));
        check("the Command Center: JoyaSound with the saved prefs, a browser host, silent (this browser is not switched on)", pre.prefs.vol === 30 && pre.prefs.on && !pre.host.desktop && pre.why === "browser" && !pre.unl, JSON.stringify(pre));
        await page.evaluate(() => { window.JoyaSound.setBrowserOn(true); window.JoyaSound.setPrefs({ quiet: false }); });
        const locked = await page.evaluate(() => window.JoyaSound.silentWhy());
        await page.mouse.click(5, 5);
        await page.waitForFunction(() => window.JoyaSound.unlocked(), null, { timeout: 5000 }).catch(() => {});
        const unl = await page.evaluate(() => window.JoyaSound.unlocked());
        check("switched on in this browser: still silent before a gesture (locked); a click unlocks the audio", locked === "locked" && unl, locked + " " + unl);
        const got = await page.evaluate(async () => {
          const O = window.__joyaCC.orbit;
          const base = [{ id: "p1", label: "Planning", name: "Planning mandate", st: "working", role: "planning", subs: [] }, { id: "e1", label: "Odoo", name: "Odoo dev", st: "idle", role: "erp", subs: [] }];
          O.setNodes(base);
          O.setNodes([Object.assign({}, base[0], { st: "waiting" }), base[1]]);
          await new Promise((r) => setTimeout(r, 700));
          return window.JoyaSound.log().filter((x) => x.why === "played").map((x) => x.name + ":" + x.role);
        });
        check("a planning session starts waiting on you: one 'needs' chirp in the planning voice", got.join() === "needs:planning", got.join());
        const map = await page.evaluate(async () => {
          window.JoyaSound.setPrefs({ on: false });
          const before = window.JoyaSound.log().length;
          window.__joyaCC.orbit.setNodes([{ id: "e1", label: "Odoo", name: "Odoo dev", st: "waiting", role: "erp", subs: [] }]);
          await new Promise((r) => setTimeout(r, 500));
          return window.JoyaSound.log().slice(before).map((x) => x.why);
        });
        check("switched off (the person's switch): the next one is silent", map.length && map.every((w) => w === "off"), map.join());
        await ctx.close();
      }
      for (const theme of ["dark", "light"]) {
        const { ctx, page } = await open("/joya-ai/settings/appearance", theme);
        await page.waitForSelector("#joya-sound-set.js", { timeout: 10000 });
        if (theme === "dark") {
          await page.click("#s-sound-browser .sw");
          const bo = await page.evaluate(() => window.localStorage.getItem("joya-sound-browser"));
          await page.click("#s-sound-quiet .sw");
          await page.waitForFunction(() => /Saved/.test(document.getElementById("joya-sound-note").textContent), null, { timeout: 5000 }).catch(() => {});
          await page.$eval('[data-snd="vol"]', (el) => { el.value = "45"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.waitForFunction(() => /45 %/.test(document.getElementById("joya-sound-note").textContent), null, { timeout: 5000 }).catch(() => {});
          const st = JSON.parse(db.getUserByName("sndadmin").joya_sound);
          const note = await page.textContent("#joya-sound-note");
          check("Settings: this browser's switch goes to localStorage only; quiet hours and the slider save at once", bo === "1" && st.quiet === false && st.vol === 45 && /Saved\. Sounds: on · 45 % · no quiet hours/.test(note), JSON.stringify({ bo, st, note }));
          await page.click('[data-snd-try="approval"]');
          await page.waitForTimeout(200);
          const pv = await page.evaluate(() => ({ unl: window.JoyaSound.unlocked(), note: document.getElementById("joya-sound-note").textContent }));
          check("Listen: the click unlocks the audio and plays (no error)", pv.unl && !/cannot play/.test(pv.note), JSON.stringify(pv));
          await page.evaluate(() => { const q = document.querySelector("#s-sound-quiet input"); q.click(); });
          await page.waitForTimeout(400);
          await page.$eval('[data-snd="vol"]', (el) => { el.value = "30"; el.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.waitForTimeout(400);
        }
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          const g = await page.$("#joya-sound-set");
          await g.scrollIntoViewIfNeeded();
          await page.evaluate(() => { document.getElementById("joya-sound-note").textContent = ""; });
          await g.screenshot({ path: path.join(SHOTS, "settings-sounds-" + theme + ".png") });
          await page.setViewportSize({ width: 390, height: 900 });
          await page.waitForTimeout(150);
          await page.evaluate(() => { const g = document.getElementById("joya-sound-set"); g.scrollIntoView({ block: "start" }); let p = g.parentElement; while (p && p !== document.body && !(p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; ((p && p !== document.body) ? p : document.scrollingElement).scrollBy(0, -130); });
          await page.waitForTimeout(150);
          await page.screenshot({ path: path.join(SHOTS, "settings-sounds-" + theme + "-phone.png") });
          const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          check(theme + ": at phone width no sideways scroll", !over);
        }
        await ctx.close();
      }
      check("no page errors and no CSP refusals", errs.length === 0, errs.join(" | "));
    }
  } finally {
    if (browser) await browser.close();
    s.stop();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
