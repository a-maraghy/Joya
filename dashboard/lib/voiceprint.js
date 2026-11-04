"use strict";
/**
 * The voiceprints (2026-10-07; stored voiceprints by name since the evening):
 * JOYA AI's live voice tells the people it knows apart -- each stored
 * voiceprint has a name (Sara, Omar...) -- from voices it does not
 * know (people in the room, a TV) and from its own voice coming back through
 * the speakers, and addresses whoever it recognised by name.
 *
 *   Settings > Voice > Voiceprint       On / Off (default On). Off: the relay never
 *                                       calls the service; nothing is scored or logged.
 *   "Only respond to stored voices"     Off by default = SHADOW: every turn is scored,
 *                                       logged and the speaker named; no turn is blocked.
 *                                       On = the gate below.
 *   per person "May give commands"      Off: they are answered in conversation only (no
 *                                       hand-off to JOYA AI, no screen action, no "yes"
 *                                       to a confirm). Identification, not authentication:
 *                                       approvals and destructive actions still need the
 *                                       signed-in user's click / Windows Hello.
 *
 * Per turn (a hold-to-talk press, a hands-free VAD segment) the relay
 * (lib/voice-live.js) sends the turn's speech (its first 3 s) to joya-voiceprint
 * (voiceprint/server.py: WeSpeaker ResNet34-LM in ONNX Runtime on a Unix
 * socket) and compares the embedding with EVERY stored print (cosine, 1-vs-N):
 * decide() below.
 *
 *   accept     best >= accept, and best - second >= margin   -> that person
 *   sticky     the call's current speaker, doubtful but at least stickyMin and not
 *              clearly someone else (a stored person ahead by the margin)  -> that speaker
 *   unverified under 0.8 s of speech, not clearly anyone          -> goes on, unnamed
 *   uncertain  in between, or two stored people too close         -> gate: not answered
 *   reject     every stored print below reject (an unknown voice) -> gate: ignored
 *   echo       over JOYA AI's playback and closer to its own voice -> gate: dropped
 *   none / error  nothing enrolled / the service failed           -> goes on (fail open)
 *
 * Storage. Each print is an embedding (sums per microphone), biometric data:
 * kept only SEALED (AES-256-GCM) by the helper, whose key is root-only and never
 * leaves it (joya-helper voiceprint-seal / -open / -forget). On disk here:
 * DATA_DIR/voiceprint/people.json (0600): per person the name, the spoken name,
 * the linked dashboard user, "may give commands", the microphones' facts and the
 * sealed blob. The prints are opened into this process's memory only. Names are
 * not secrets but go only to the ledger, the hand-off to JOYA AI and the page.
 * JOYA AI's own voice print (the echo rule) is learned from what the relay
 * plays, DATA_DIR/voiceprint/tts.json. Enrolment never stores audio.
 *
 * The ledger (table voiceprint_checks): one row per turn checked -- scores,
 * verdict, the speaker, what was done -- for tuning and the 7-day view.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const SOCKET = process.env.JOYA_VOICEPRINT_SOCKET || "/run/joya-voiceprint/voiceprint.sock";
const ENABLED_SETTING = "voiceprint_enabled";
const GATE_SETTING = "voiceprint_gate";
const THRESHOLDS_SETTING = "voiceprint_thresholds";
// first: the seconds of a turn's speech scored (whole turns up to 3 s; 2026-10-07: 1.2 s from a
// misaligned window left 0.5-0.7 s). min: less speech than this is "unverified" (let through).
// stickyMs: after a turn verified as the administrator's, doubtful turns in the same call are theirs.
// stickyMin: the lowest score a doubtful turn may have to count as the call's voice (default = reject;
// raise it, e.g. 0.25, to let fewer other people through in a call where you were recognised).
// margin: how far the best stored person must be ahead of the second to be named (1-vs-N).
const DEFAULTS = Object.freeze({ accept: 0.31, reject: 0.2, echo: 0.45, first: 3, min: 0.8, timeoutMs: 400, stickyMs: 10 * 60 * 1000, stickyMin: 0.2, margin: 0.05 });
const MAX_PEOPLE = 10;
// A display name: Latin letters, digits, spaces and . - ' (1-40). A spoken name: any letters (Arabic too), up to 40.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,39}$/;
const SPOKEN_RE = /^[\p{L}\p{M}\p{N} .'\u0640-]{1,40}$/u;
// This deployment's own print, made before prints had names (2026-10-07): it becomes this person.
const MIGRATE_NAMES = Object.freeze({});
const MODEL = "WeSpeaker ResNet34-LM (VoxCeleb2), CC-BY-4.0";

/*
 * Strictness (Settings ▸ Voice ▸ Voiceprint): how much benefit of the doubt a call gives once the
 * administrator has been recognised in it. The figures are the live replay of 2026-10-07
 * (tools/voiceprint/live_replay.py: the administrator's 30 trial phrases, 200 other people from
 * Common Voice, whole turns through the live code path): other people scoring 0.20-0.25 were 9.5 %,
 * 0.25-0.31 8 %, above 0.31 1 %; the administrator's lowest phrase 0.40.
 */
const PRESETS = Object.freeze([
  { id: "relaxed", label: "Relaxed", stickyMin: 0.2, effect: "Once someone is recognised in a call, about 18 % of unknown voices would be answered as them. Their own turns: none missed in tests." },
  { id: "strict", label: "Strict (recommended)", stickyMin: 0.25, effect: "Once someone is recognised in a call, about 9 % of unknown voices would be answered as them. Their own turns: unchanged in tests." },
  { id: "very_strict", label: "Very strict", stickyMin: 0.31, effect: "No leniency within a call: about 1 % of unknown voices answered. Their own turns: unchanged in tests; unsure turns are never answered." },
]);
// What the Advanced fields may hold (server-side checked): reject < stickyMin <= accept.
const BOUNDS = Object.freeze({ accept: [0.05, 0.8], reject: [0.05, 0.8], stickyMin: [0.05, 0.8], echo: [0.2, 0.9] });
const TUNABLE = Object.freeze(["accept", "reject", "stickyMin", "echo"]);

/** {accept, reject, stickyMin, echo} (strings or numbers) -> { ok, values } | { ok: false, error }. */
function validateThresholds(v) {
  const out = {};
  for (const k of TUNABLE) {
    const raw = v && v[k];
    const n = typeof raw === "number" ? raw : /^\s*-?\d*\.?\d+\s*$/.test(String(raw == null ? "" : raw)) ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${k === "stickyMin" ? "The call's-voice minimum" : k[0].toUpperCase() + k.slice(1)} must be a number.` };
    const [lo, hi] = BOUNDS[k];
    if (n < lo || n > hi) return { ok: false, error: `${k === "stickyMin" ? "The call's-voice minimum" : k[0].toUpperCase() + k.slice(1)} must be between ${lo} and ${hi}.` };
    out[k] = Math.round(n * 1000) / 1000;
  }
  if (!(out.reject < out.stickyMin)) return { ok: false, error: "“Another voice below” must be lower than the call's-voice minimum." };
  if (!(out.stickyMin <= out.accept)) return { ok: false, error: "The call's-voice minimum must not be above “Recognised from”." };
  return { ok: true, values: out };
}
/** The preset these values are, or "custom". */
function presetOf(t) {
  const th = { ...DEFAULTS, ...(t || {}) };
  if (th.accept !== DEFAULTS.accept || th.reject !== DEFAULTS.reject || th.echo !== DEFAULTS.echo) return "custom";
  const p = PRESETS.find((x) => Math.abs(x.stickyMin - th.stickyMin) < 1e-9);
  return p ? p.id : "custom";
}
const MIC_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MIN_ENROL_MS = 30000; // speech needed for a microphone's print
const TTS_MAX = 40;
const TTS_EVERY_MS = 60 * 1000;
const KEEP_DAYS = 90;
const DAY = 24 * 3600 * 1000;
const HIST = { from: -0.2, to: 1.0, step: 0.05 };

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** One request to the service on its Unix socket -> parsed JSON; rejects on a timeout or a bad answer. */
function request(socketPath, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      fn(v);
    };
    const req = http.request({ socketPath, method, path: p, headers: body ? { "Content-Type": "application/octet-stream", "Content-Length": body.length } : {} }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        let j = null;
        try {
          j = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch (_) {
          return finish(reject, new Error("the voiceprint service answered something that is not JSON"));
        }
        if (res.statusCode !== 200 || !j || j.ok === false) return finish(reject, Object.assign(new Error((j && j.error) || "HTTP " + res.statusCode), { status: res.statusCode }));
        finish(resolve, j);
      });
      res.on("error", (e) => finish(reject, e));
    });
    const t = setTimeout(() => {
      req.destroy();
      finish(reject, Object.assign(new Error("the voiceprint service took longer than " + timeoutMs + " ms"), { code: "TIMEOUT" }));
    }, timeoutMs);
    req.on("error", (e) => finish(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

/** A name for a person: { ok, value } | { ok: false, error }. */
function cleanName(v) {
  const n = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!NAME_RE.test(n)) return { ok: false, error: "A name is 1-40 Latin letters or digits (spaces, . - ' allowed), e.g. Sara." };
  return { ok: true, value: n };
}
function cleanSpoken(v) {
  const n = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!n) return { ok: true, value: "" };
  if (!SPOKEN_RE.test(n)) return { ok: false, error: "The spoken name is up to 40 letters (Arabic is fine), e.g. «عبد المنعم»." };
  return { ok: true, value: n };
}

/**
 * The 1-vs-N decision for one turn (pure; tested on its own).
 *   scores   [{ id, score }] for every stored person with a print
 *   o        { speechMs, overVoice, tts (score against JOYA AI's voice or null),
 *              current (the call's current speaker id, recent enough) }
 *   th       thresholds()
 * -> { verdict, id (who, or null), score (best), second, why }
 */
function decide(scores, o, th) {
  const list = (scores || []).slice().sort((a, b) => b.score - a.score);
  const best = list[0] || null;
  const second = list[1] ? list[1].score : null;
  const out = (verdict, id, why) => ({ verdict, id: id || null, score: best ? r3(best.score) : null, second: r3(second), ...(why ? { why } : {}) });
  if (!best) return out("none");
  const lead = second == null ? Infinity : best.score - second;
  if (o.overVoice && o.tts != null && o.tts >= th.echo && o.tts > best.score) return out("echo");
  const cur = o.current ? list.find((x) => x.id === o.current) : null;
  // The call's current speaker still fits: at least stickyMin, and nobody else clearly ahead of them.
  const curFits = !!(cur && cur.score >= Math.max(th.reject, th.stickyMin) && (best.id === cur.id || best.score - cur.score < th.margin));
  if (best.score >= th.accept && lead >= th.margin) return out("accept", best.id);
  if (best.score >= th.accept) return curFits ? out("sticky", cur.id, "the call's speaker (two voices close)") : out("uncertain", null, "two stored voices too close");
  if (best.score < th.reject) return out("reject"); // nobody stored, however short
  if (o.speechMs < th.min * 1000) return curFits ? out("sticky", cur.id, "the call's speaker") : out("unverified", null, "too short to check");
  if (curFits && !o.overVoice) return out("sticky", cur.id, "the call's speaker");
  return out("uncertain");
}

/**
 * deps: { db, priv: {voiceprintSeal, voiceprintOpen, voiceprintForget}, dataDir,
 *         socketPath?, log?, now?, parseWav?,
 *         userById?(id) -> {id, username, display_name} (the migration) }
 */
function createVoiceprint(deps) {
  const d = deps || {};
  const db = d.db;
  const priv = d.priv;
  const log = d.log || (() => {});
  const now = d.now || Date.now;
  const socketPath = d.socketPath || SOCKET;
  const dir = path.join(d.dataDir, "voiceprint");
  const peopleFile = path.join(dir, "people.json");
  const open = new Map(); // person id -> { vec: unit, mics: {mic: {sum, windows}} }
  let opening = null;
  const pending = new Map(); // person id + mic -> { clips: {id: {sum, windows, speech_ms}}, at }
  let service = { ok: null, at: 0, error: null, errorAt: 0, failures: 0, checked: 0, health: null };
  let tts = null;
  let lastTtsAt = 0;
  let pruned = 0;
  let store = null; // { v: 2, people: [...] }

  const mk = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch (_) {
      /* best effort */
    }
  };
  const writeJson = (p, obj) => {
    mk();
    fs.writeFileSync(p + ".tmp", JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(p + ".tmp", p);
  };
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      return null;
    }
  };
  const bad = (status, message) => Object.assign(new Error(message), { status });

  /* ---- the switches ---- */

  const enabled = () => db.getSetting(ENABLED_SETTING, "on") !== "off";
  const gate = () => enabled() && db.getSetting(GATE_SETTING, "off") === "on";
  function storedThresholds() {
    try {
      const t = JSON.parse(db.getSetting(THRESHOLDS_SETTING, "") || "{}");
      return t && typeof t === "object" && !Array.isArray(t) ? t : {};
    } catch (_) {
      return {};
    }
  }
  function thresholds() {
    const t = storedThresholds();
    const o = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(Number(t[k]))) o[k] = Number(t[k]);
    if (o.reject > o.accept) o.reject = o.accept;
    return o;
  }
  /** Merge `patch` into the stored thresholds (other keys kept); a key set to null goes back to its default. */
  function setThresholds(patch, by) {
    const cur = storedThresholds();
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null) delete cur[k];
      else cur[k] = v;
    }
    db.setSetting(THRESHOLDS_SETTING, JSON.stringify(cur), by);
    return thresholds();
  }
  const setEnabled = (on, by) => db.setSetting(ENABLED_SETTING, on ? "on" : "off", by);
  const setGate = (on, by) => db.setSetting(GATE_SETTING, on ? "on" : "off", by);

  /* ---- the service ---- */

  function failed(e) {
    service = { ...service, ok: false, error: String((e && e.message) || e).slice(0, 200), errorAt: now(), failures: service.failures + 1 };
  }
  function worked() {
    service = { ...service, ok: true, at: now(), failures: 0 };
  }
  async function health(force) {
    if (!force && service.health && now() - service.at < 30000) return service.health;
    try {
      const h = await request(socketPath, "GET", "/health", null, 1500);
      service = { ...service, ok: true, at: now(), health: h };
      return h;
    } catch (e) {
      failed(e);
      return null;
    }
  }
  async function embed(pcm, rate, first, timeoutMs) {
    const j = await request(socketPath, "POST", `/embed?rate=${rate}&first=${first == null ? thresholds().first : first}`, pcm, timeoutMs || thresholds().timeoutMs);
    if (j.embedding != null && (!Array.isArray(j.embedding) || j.embedding.length < 64 || !j.embedding.every(Number.isFinite))) throw new Error("the voiceprint service answered a malformed embedding");
    return j;
  }
  async function enrolEmbed(pcm, rate) {
    const j = await request(socketPath, "POST", `/enrol?rate=${rate}`, pcm, 30000);
    if (!Array.isArray(j.embedding) || !j.embedding.every(Number.isFinite)) throw new Error("the voiceprint service answered a malformed embedding");
    return j;
  }

  /* ---- the people: people.json, prints sealed in it ---- */

  function load() {
    if (store) return store;
    const f = readJson(peopleFile);
    if (f && Array.isArray(f.people)) return (store = f);
    store = { v: 2, people: [] };
    migrate();
    return store;
  }
  function persist() {
    writeJson(peopleFile, store);
  }
  /** Before names (one print per dashboard user, DATA_DIR/voiceprint/<user id>.json): each becomes a person. */
  function migrate() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch (_) {
      files = [];
    }
    if (!files.length) return;
    for (const f of files) {
      const old = readJson(path.join(dir, f));
      if (!old || !old.sealed) continue;
      const uid = Number(f.replace(".json", ""));
      const u = d.userById ? d.userById(uid) : null;
      const named = (u && MIGRATE_NAMES[u.username]) || null;
      const nm = cleanName(named ? named.name : (u && (u.display_name || u.username)) || "Person " + uid);
      store.people.push({
        id: newId(),
        name: nm.ok ? nm.value : "Person " + uid,
        spoken: named ? named.spoken : "",
        user_id: uid,
        may_command: true,
        created_at: old.created_at || new Date(now()).toISOString(),
        updated_at: old.updated_at || null,
        last_heard: null,
        mics: old.mics || {},
        sealed: old.sealed,
      });
    }
    persist();
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch (_) {
        /* kept */
      }
    }
    log(`voiceprint: ${store.people.length} voiceprint(s) moved to stored voiceprints by name`);
  }
  function newId() {
    let id;
    do id = "p" + require("crypto").randomBytes(4).toString("hex");
    while (store.people.some((p) => p.id === id));
    return id;
  }
  const pub = (p) => ({ id: p.id, name: p.name, spoken: p.spoken || "", user_id: p.user_id == null ? null : p.user_id, may_command: !!p.may_command, created_at: p.created_at, updated_at: p.updated_at || null, last_heard: p.last_heard || null, mics: p.mics || {}, enrolled: !!p.sealed });
  function people() {
    return load().people.map(pub);
  }
  function find(pid) {
    return load().people.find((p) => p.id === String(pid)) || null;
  }
  function person(pid) {
    const p = find(pid);
    return p ? pub(p) : null;
  }
  function personForUser(user) {
    const p = user ? load().people.find((x) => x.user_id === Number(user.id)) : null;
    return p ? pub(p) : null;
  }
  function addPerson(o) {
    load();
    if (store.people.length >= MAX_PEOPLE) throw bad(400, `At most ${MAX_PEOPLE} stored voiceprints.`);
    const n = cleanName(o && o.name);
    if (!n.ok) throw bad(400, n.error);
    const sp = cleanSpoken(o && o.spoken);
    if (!sp.ok) throw bad(400, sp.error);
    if (store.people.some((p) => p.name.toLowerCase() === n.value.toLowerCase())) throw bad(400, "There is already a voiceprint called " + n.value + ".");
    const uid = o && o.user_id != null ? Number(o.user_id) : null;
    if (uid != null && store.people.some((p) => p.user_id === uid)) throw bad(400, "That dashboard user already has a voiceprint.");
    const p = { id: newId(), name: n.value, spoken: sp.value, user_id: uid, may_command: o && o.may_command != null ? !!o.may_command : uid != null, created_at: new Date(now()).toISOString(), updated_at: null, last_heard: null, mics: {}, sealed: null };
    store.people.push(p);
    persist();
    return pub(p);
  }
  function updatePerson(pid, patch) {
    const p = find(pid);
    if (!p) throw bad(404, "No such voiceprint.");
    if (patch.name !== undefined) {
      const n = cleanName(patch.name);
      if (!n.ok) throw bad(400, n.error);
      if (store.people.some((x) => x !== p && x.name.toLowerCase() === n.value.toLowerCase())) throw bad(400, "There is already a voiceprint called " + n.value + ".");
      p.name = n.value;
    }
    if (patch.spoken !== undefined) {
      const sp = cleanSpoken(patch.spoken);
      if (!sp.ok) throw bad(400, sp.error);
      p.spoken = sp.value;
    }
    if (patch.may_command !== undefined) p.may_command = !!patch.may_command;
    persist();
    return pub(p);
  }
  async function removePerson(pid) {
    load();
    const i = store.people.findIndex((p) => p.id === String(pid));
    if (i < 0) return null;
    const [p] = store.people.splice(i, 1);
    open.delete(p.id);
    for (const k of [...pending.keys()]) if (k.startsWith(p.id + "|")) pending.delete(k);
    persist();
    return pub(p);
  }

  /* ---- the prints, open in memory ---- */

  function build(mics) {
    const keys = Object.keys(mics || {}).filter((m) => mics[m] && Array.isArray(mics[m].sum) && mics[m].windows > 0);
    if (!keys.length) return null;
    const sum = new Array(mics[keys[0]].sum.length).fill(0);
    for (const m of keys) mics[m].sum.forEach((v, i) => (sum[i] += v));
    return { vec: unit(sum), mics };
  }
  /** Open every stored print (each once, through the helper). */
  function openAll() {
    if (opening) return opening;
    opening = (async () => {
      for (const p of load().people) {
        if (!p.sealed || open.has(p.id)) continue;
        try {
          const r = await priv.voiceprintOpen(p.sealed);
          const plain = JSON.parse(Buffer.from(r.plain, "base64").toString("utf8"));
          const pr = build(plain.mics);
          if (pr) open.set(p.id, pr);
        } catch (e) {
          log("voiceprint: could not open a stored voiceprint: " + e.message);
        }
      }
    })().finally(() => (opening = null));
    return opening;
  }
  const hasPrints = () => open.size > 0;
  async function printOf(pid) {
    if (!open.has(pid)) await openAll();
    return open.get(pid) || null;
  }
  async function save(p, mics) {
    const plain = Buffer.from(JSON.stringify({ v: 1, model: MODEL, mics }), "utf8").toString("base64");
    const r = await priv.voiceprintSeal(plain);
    p.sealed = r.sealed;
    p.updated_at = new Date(now()).toISOString();
    persist();
    const pr = build(mics);
    if (pr) open.set(p.id, pr);
    else open.delete(p.id);
  }

  /* ---- enrolment (per person, per microphone) ---- */

  const pkey = (pid, mic) => pid + "|" + mic;
  async function enrolClip(pid, mic, clipId, pcm, rate) {
    if (!find(pid)) throw bad(404, "No such voiceprint.");
    if (!MIC_RE.test(mic)) throw bad(400, "Which microphone?");
    const j = await enrolEmbed(pcm, rate);
    const k = pkey(pid, mic);
    const p = pending.get(k) || { clips: {}, at: now() };
    p.clips[clipId] = { sum: j.embedding, windows: j.windows, speech_ms: j.speech_ms };
    p.at = now();
    pending.set(k, p);
    return { speech_ms: j.speech_ms, windows: j.windows, total_ms: Object.values(p.clips).reduce((n, c) => n + c.speech_ms, 0) };
  }
  function pendingOf(pid, mic) {
    const p = pending.get(pkey(pid, mic));
    return p ? { clips: Object.keys(p.clips), total_ms: Object.values(p.clips).reduce((n, c) => n + c.speech_ms, 0) } : { clips: [], total_ms: 0 };
  }
  const discardPending = (pid, mic) => pending.delete(pkey(pid, mic));
  async function enrolSave(pid, mic, source) {
    const person0 = find(pid);
    if (!person0) throw bad(404, "No such voiceprint.");
    const k = pkey(pid, mic);
    const pend = pending.get(k);
    const clips = pend ? Object.values(pend.clips) : [];
    const total = clips.reduce((n, c) => n + c.speech_ms, 0);
    if (total < MIN_ENROL_MS) throw bad(400, `Not enough speech yet: ${Math.round(total / 1000)} s of the ${MIN_ENROL_MS / 1000} s needed.`);
    const sum = new Array(clips[0].sum.length).fill(0);
    let windows = 0;
    for (const c of clips) {
      c.sum.forEach((v, i) => (sum[i] += v));
      windows += c.windows;
    }
    const cur = (await printOf(pid)) || { mics: {} };
    const mics = { ...cur.mics, [mic]: { sum, windows } };
    person0.mics = { ...(person0.mics || {}), [mic]: { windows, speech_s: Math.round(total / 100) / 10, clips: clips.length, source: source || "enrol", at: new Date(now()).toISOString() } };
    await save(person0, mics);
    pending.delete(k);
    return { person: pid, name: person0.name, mic, windows, speech_s: person0.mics[mic].speech_s, mics: Object.keys(mics) };
  }
  async function removeMic(pid, mic) {
    const p = find(pid);
    const cur = p ? await printOf(pid) : null;
    if (!p || !cur || !cur.mics[mic]) return false;
    const mics = { ...cur.mics };
    delete mics[mic];
    const info = { ...(p.mics || {}) };
    delete info[mic];
    p.mics = info;
    if (!Object.keys(mics).length) {
      p.sealed = null;
      open.delete(p.id);
      persist();
      return true;
    }
    await save(p, mics);
    return true;
  }
  /** Everything: every stored voiceprint, the ledger, JOYA AI's voice print; the key too. */
  async function forgetAll() {
    const n = load().people.length;
    store.people = [];
    open.clear();
    pending.clear();
    persist();
    try {
      fs.unlinkSync(path.join(dir, "tts.json"));
    } catch (_) {
      /* none */
    }
    tts = null;
    const rows = db.voiceprintChecksDeleteAll();
    const helper = await priv.voiceprintForget(false);
    return { people: n, ledger_rows: rows, key_deleted: !!(helper && helper.key_deleted), results_deleted: (helper && helper.results_deleted) || 0 };
  }

  /* ---- JOYA AI's own voice (the echo rule) ---- */

  function ttsLoad() {
    if (!tts) tts = readJson(path.join(dir, "tts.json")) || { voices: {} };
    return tts;
  }
  function ttsPrint(voice) {
    const v = ttsLoad().voices[voice];
    return v && v.n > 0 ? unit(v.sum) : null;
  }
  async function learnTts(voice, pcm) {
    if (!enabled() || !/^[a-z]{2,20}$/.test(String(voice || "")) || !pcm || pcm.length < 24000 * 2 * 1.5) return false;
    const v = ttsLoad().voices[voice];
    if ((v && v.n >= TTS_MAX) || now() - lastTtsAt < TTS_EVERY_MS) return false;
    lastTtsAt = now();
    try {
      const j = await embed(pcm, 24000, 3, 1500);
      if (!j.embedding) return false;
      const cur = ttsLoad().voices[voice] || { sum: new Array(j.embedding.length).fill(0), n: 0 };
      cur.sum = cur.sum.map((x, i) => x + j.embedding[i]);
      cur.n += 1;
      cur.at = new Date(now()).toISOString();
      ttsLoad().voices[voice] = cur;
      writeJson(path.join(dir, "tts.json"), tts);
      return true;
    } catch (e) {
      failed(e);
      return false;
    }
  }

  /* ---- the check: who is speaking ---- */

  /**
   * One turn: pcm = PCM16 24 kHz (what the relay relayed). Never throws: a
   * failure is {verdict: "error"} (the caller goes on: fail open).
   * o: { overVoice, voice, current: { id, at } (the call's current speaker) }
   * -> { verdict, speaker: {id, name, spoken, may_command} | null, score, second, tts_score, ... }
   */
  async function check(pcm, o) {
    const t0 = now();
    const th = thresholds();
    if (!open.size) await openAll();
    if (!open.size) return { verdict: "none", ms: now() - t0 };
    let j;
    try {
      j = await embed(pcm, 24000, th.first, th.timeoutMs);
      worked();
      service.checked++;
    } catch (e) {
      failed(e);
      return { verdict: "error", error: String(e.message).slice(0, 120), ms: now() - t0 };
    }
    const out = { speech_ms: j.speech_ms, used_ms: j.used_ms, svc_ms: j.ms, ms: now() - t0 };
    if (!j.embedding) return { ...out, verdict: "unverified", speaker: null, why: "under 0.3 s of speech" };
    const scores = [...open.entries()].map(([id, pr]) => ({ id, score: dot(pr.vec, j.embedding) }));
    const tp = o && o.voice ? ttsPrint(o.voice) : null;
    const tts = tp ? dot(tp, j.embedding) : null;
    const cur = o && o.current && o.current.id && now() - (o.current.at || 0) <= th.stickyMs ? o.current.id : null;
    const v = decide(scores, { speechMs: j.speech_ms, overVoice: !!(o && o.overVoice), tts, current: cur }, th);
    const p = v.id ? find(v.id) : null;
    if (p && (v.verdict === "accept" || v.verdict === "sticky")) {
      p.last_heard = new Date(now()).toISOString();
      if (now() - (p._lastSaved || 0) > 60000) {
        p._lastSaved = now();
        try {
          persist();
        } catch (_) {
          /* best effort */
        }
      }
    }
    return { ...out, verdict: v.verdict, speaker: p ? { id: p.id, name: p.name, spoken: p.spoken || "", may_command: !!p.may_command } : null, score: v.score, second: v.second, tts_score: r3(tts), ...(v.why ? { why: v.why } : {}) };
  }

  /* ---- the ledger ---- */

  function ledger(row) {
    try {
      db.voiceprintCheckInsert({ ts: now(), ...row });
      if (now() - pruned > DAY) {
        pruned = now();
        db.voiceprintChecksPrune(now() - KEEP_DAYS * DAY);
      }
    } catch (e) {
      log("voiceprint: could not write the ledger: " + e.message);
    }
  }
  /** The last `days` days: per verdict, per person, what the gate would have done, a score histogram. */
  function stats(days) {
    const rows = db.voiceprintChecksSince(now() - (days || 7) * DAY, null);
    const by = { accept: 0, sticky: 0, unverified: 0, uncertain: 0, reject: 0, echo: 0, short: 0, error: 0 };
    const per = {};
    const acted = {};
    const bins = Math.round((HIST.to - HIST.from) / HIST.step);
    const hist = new Array(bins).fill(0);
    const scores = [];
    const ms = [];
    for (const r of rows) {
      if (by[r.verdict] !== undefined) by[r.verdict]++;
      if (r.speaker_id && (r.verdict === "accept" || r.verdict === "sticky")) {
        const p = find(r.speaker_id);
        const k = p ? p.id : r.speaker_id;
        per[k] = per[k] || { id: k, name: p ? p.name : r.speaker || "(deleted)", turns: 0, talk_only: 0 };
        per[k].turns++;
        if (r.acted && /talk only/.test(r.acted)) per[k].talk_only++;
      }
      if (r.acted) acted[r.acted] = (acted[r.acted] || 0) + 1;
      if (r.score != null) {
        scores.push(r.score);
        hist[Math.max(0, Math.min(bins - 1, Math.floor((r.score - HIST.from) / HIST.step)))]++;
      }
      if (r.ms != null) ms.push(r.ms);
    }
    scores.sort((a, b) => a - b);
    ms.sort((a, b) => a - b);
    const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
    return {
      days: days || 7,
      checked: rows.length,
      by,
      people: Object.values(per).sort((a, b) => b.turns - a.turns),
      unknown: by.reject,
      unsure: by.uncertain,
      acted,
      would_ignore: by.reject + by.echo,
      would_ask: by.uncertain,
      answered: by.accept + by.sticky + by.unverified + by.short,
      hist,
      hist_from: HIST.from,
      hist_step: HIST.step,
      score_p10: r3(q(scores, 0.1)),
      score_p50: r3(q(scores, 0.5)),
      ms_p50: q(ms, 0.5),
      ms_p95: q(ms, 0.95),
      last: rows.length ? rows[rows.length - 1].ts : null,
    };
  }

  function status(user) {
    const recentError = service.errorAt && now() - service.errorAt < 10 * 60 * 1000 && service.ok === false;
    const ps = people();
    return {
      enabled: enabled(),
      gate: gate(),
      thresholds: thresholds(),
      preset: presetOf(thresholds()),
      service: { ok: service.ok, error: recentError ? service.error : null, errorAt: service.errorAt || null, health: service.health ? { model: service.health.model, dim: service.health.dim, threads: service.health.threads } : null },
      people: ps,
      enrolledCount: ps.filter((p) => p.enrolled).length,
      me: user ? personForUser(user) : null,
      max: MAX_PEOPLE,
      model: MODEL,
    };
  }

  return {
    SOCKET: socketPath,
    enabled,
    gate,
    thresholds,
    storedThresholds,
    setThresholds,
    setEnabled,
    setGate,
    health,
    embed,
    check,
    hasPrints,
    openAll,
    people,
    person,
    personForUser,
    addPerson,
    updatePerson,
    removePerson,
    enrolClip,
    enrolSave,
    pendingOf,
    discardPending,
    removeMic,
    forgetAll,
    learnTts,
    ttsPrint,
    ledger,
    stats,
    status,
    serviceState: () => ({ ...service }),
  };
}

module.exports = { createVoiceprint, decide, cleanName, cleanSpoken, PRESETS, BOUNDS, TUNABLE, validateThresholds, presetOf, DEFAULTS, MAX_PEOPLE, MIGRATE_NAMES, MODEL, ENABLED_SETTING, GATE_SETTING, THRESHOLDS_SETTING, MIN_ENROL_MS, MIC_RE, request, unit, dot };
