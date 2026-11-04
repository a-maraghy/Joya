"use strict";
/*
 * JOYA AI's sound identity (2026-10-20): small, quiet sounds so you can tell what happened without
 * looking. Design note and the rendered sounds: mockups/sound-identity/ (tools/make-sound-identity.cjs).
 *
 *   JoyaSound.play(name, { role })   a sound, if it may play now -> { ok, why }
 *     bot chirps (EMO style), one voice per session role (cc-logic.js BOT_ROLE_RULES, plus "core" for
 *     JOYA AI itself): wake · think (work starts) · done · needs (needs you) · error
 *     two key sounds, the same for everyone: approval (a soft chime: an approval is waiting) · job
 *     (a different chime: a job finished)
 *   JoyaSound.preview(name, { role })  the Settings preview: plays now (needs the audio unlocked; ignores
 *                                      quiet hours, the switches and the limiter -- you asked for it)
 *
 * The rules (all here, so every caller gets them):
 *   - quiet by default (30 %), one volume and an off switch, stored per person (users.joya_sound, POST
 *     /joya-ai/api/prefs/sound, Settings > Appearance > Sounds);
 *   - in a plain browser silent unless switched on in that browser (localStorage "joya-sound-browser");
 *     the desktop app (?shell=desktop) follows the per-person switch;
 *   - never stacking: events within MERGE_MS merge into one (the most important wins), at least GAP_MS
 *     between two sounds, a cooldown per sound and role, at most BUDGET per minute, a sound held too
 *     long is dropped, and two tabs of this browser never play the same moment twice;
 *   - silent during a live voice call or while the voice speaks (mutedBy probes from joya-ai.js);
 *   - silent in quiet hours (default 23:00-07:00, a setting);
 *   - silent while the desktop app says do-not-disturb (setHost({ dnd }) from joya-desktop.js, when the
 *     app sends it);
 *   - autoplay: nothing before a user gesture unlocked the audio (pointerdown / keydown / touchend);
 *     in the desktop app, where the host may allow audio without one, a context that starts "running"
 *     counts as unlocked.
 *
 * Procedural: every sound is a short recipe of notes (pitch glides, envelopes, a touch of FM or a
 * low-pass) played through WebAudio -- no sample files. The same recipes render to WAV offline.
 * No inline style, no eval, no network (the CSP).
 */
(function () {
  /* ------------------------------------------------------------------ prefs (also used by the server) */
  var DEFAULTS = { on: true, vol: 30, quiet: true, from: "23:00", to: "07:00" };
  var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  function normSoundPrefs(v) {
    if (typeof v === "string") { try { v = v ? JSON.parse(v) : {}; } catch (e) { v = {}; } }
    if (!v || typeof v !== "object" || Array.isArray(v)) v = {};
    var vol = Number(v.vol);
    return {
      on: typeof v.on === "boolean" ? v.on : DEFAULTS.on,
      vol: isFinite(vol) && vol >= 0 && vol <= 100 && v.vol !== null && v.vol !== "" ? Math.round(vol) : DEFAULTS.vol,
      quiet: typeof v.quiet === "boolean" ? v.quiet : DEFAULTS.quiet,
      from: typeof v.from === "string" && HHMM.test(v.from) ? v.from : DEFAULTS.from,
      to: typeof v.to === "string" && HHMM.test(v.to) ? v.to : DEFAULTS.to,
    };
  }
  function soundPrefsJson(v) { return JSON.stringify(normSoundPrefs(v)); }
  /** The API's check (POST /joya-ai/api/prefs/sound): any of on, vol, quiet, from, to -> { ok, edit } or { ok: false, error }. */
  function checkSoundEdit(b) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "Send on, vol, quiet, from or to." };
    var e = {}, n = 0;
    if (b.on !== undefined) { if (typeof b.on !== "boolean") return { ok: false, error: "on must be true or false." }; e.on = b.on; n++; }
    if (b.vol !== undefined) {
      if (typeof b.vol !== "number" || !isFinite(b.vol) || b.vol < 0 || b.vol > 100 || Math.round(b.vol) !== b.vol) return { ok: false, error: "The volume must be a whole number from 0 to 100." };
      e.vol = b.vol; n++;
    }
    if (b.quiet !== undefined) { if (typeof b.quiet !== "boolean") return { ok: false, error: "quiet must be true or false." }; e.quiet = b.quiet; n++; }
    ["from", "to"].forEach(function (k) {
      if (b[k] === undefined || e.error) return;
      if (typeof b[k] !== "string" || !HHMM.test(b[k])) e.error = "Quiet hours must be HH:MM (00:00 to 23:59).";
      else { e[k] = b[k]; n++; }
    });
    if (e.error) return { ok: false, error: e.error };
    if (!n) return { ok: false, error: "Send on, vol, quiet, from or to." };
    return { ok: true, edit: e };
  }
  function applySoundEdit(cur, edit) {
    var p = normSoundPrefs(cur);
    Object.keys(edit || {}).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) p[k] = edit[k]; });
    return normSoundPrefs(p);
  }
  /** One line for the audit and the Settings note: "on · 30 % · quiet 23:00-07:00". */
  function soundPrefsLine(v) {
    var p = normSoundPrefs(v);
    return (p.on ? "on" : "off") + " · " + p.vol + " %" + " · " + (p.quiet ? "quiet " + p.from + "–" + p.to : "no quiet hours");
  }
  function minutesOf(hhmm) { var m = HHMM.exec(hhmm); return m ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : -1; }
  /** In quiet hours at this time? The window may wrap past midnight; from === to is an empty window. */
  function inQuietHours(date, from, to) {
    var f = minutesOf(from), t = minutesOf(to);
    if (f < 0 || t < 0 || f === t) return false;
    var m = date.getHours() * 60 + date.getMinutes();
    return f < t ? m >= f && m < t : m >= f || m < t;
  }

  /* ------------------------------------------------------------------ the sounds */
  var CHIRPS = ["wake", "think", "done", "needs", "error"];
  var KEYS = ["approval", "job"];
  var NAMES = CHIRPS.concat(KEYS);
  // Which one wins when several arrive together (higher wins).
  var PRIORITY = { approval: 7, error: 6, needs: 5, job: 4, done: 3, wake: 2, think: 1 };
  // A sound (and role) does not repeat within its cooldown (ms).
  var COOLDOWN = { approval: 5000, error: 8000, needs: 6000, job: 5000, done: 4000, wake: 30000, think: 10000 };
  var MERGE_MS = 350, GAP_MS = 1200, MAX_AGE_MS = 4000, BUDGET = 8, BUDGET_MS = 60000;
  // One voice per role: a pitch (ratio), a waveform and a touch of colour.
  var ROLES = {
    core: { pitch: 1, wave: "sine", label: "JOYA AI" },
    hired: { pitch: 1.122, wave: "triangle", label: "Hired" },                    // +2 semitones, a little brighter
    planning: { pitch: 0.891, wave: "sine", harm: 0.22, label: "Planning" },      // -2 semitones, an octave partial: rounder
    erp: { pitch: 0.794, wave: "square", lp: 1900, label: "Odoo / ERP" },         // -4 semitones, a filtered square: woodier
    builder: { pitch: 1.26, wave: "sine", fm: { ratio: 2, index: 0.9 }, label: "Joya / builder" }, // +4, a light FM: metallic
    other: { pitch: 0.944, wave: "triangle", lp: 3200, label: "Other" },          // -1 semitone, soft triangle
  };
  function roleOf(r) { return Object.prototype.hasOwnProperty.call(ROLES, r) ? r : r ? "other" : "core"; }
  // The shapes (Hz, s, gain 0-1). t start, d length, f0 -> f1 an exponential glide, vib {rate, depth}.
  var SHAPES = {
    wake: [{ t: 0, d: 0.15, f0: 560, f1: 860, g: 0.42 }, { t: 0.15, d: 0.24, f0: 820, f1: 1420, g: 0.55, vib: { rate: 7, depth: 0.018 } }],
    think: [{ t: 0, d: 0.1, f0: 1150, f1: 1420, g: 0.32 }],
    done: [{ t: 0, d: 0.08, f0: 1040, f1: 1060, g: 0.42 }, { t: 0.1, d: 0.17, f0: 1300, f1: 1560, g: 0.52 }],
    needs: [{ t: 0, d: 0.07, f0: 1320, f1: 1320, g: 0.4 }, { t: 0.11, d: 0.07, f0: 1320, f1: 1320, g: 0.4 }, { t: 0.22, d: 0.16, f0: 1320, f1: 1780, g: 0.5 }],
    error: [{ t: 0, d: 0.12, f0: 720, f1: 660, g: 0.45 }, { t: 0.13, d: 0.3, f0: 660, f1: 330, g: 0.5, vib: { rate: 9, depth: 0.03 } }],
  };
  // The key sounds: a two-note bell (approval waiting) and three rising marimba notes (a job done).
  var KEY_RECIPES = {
    approval: [
      { t: 0, d: 1.1, f0: 1318.5, f1: 1318.5, g: 0.34, wave: "sine", fm: { ratio: 3.5, index: 1.1, decay: 0.3 }, a: 0.004 },
      { t: 0.17, d: 1.35, f0: 1975.5, f1: 1975.5, g: 0.28, wave: "sine", fm: { ratio: 3.5, index: 0.8, decay: 0.3 }, a: 0.004 },
    ],
    job: [
      { t: 0, d: 0.32, f0: 1046.5, f1: 1046.5, g: 0.36, wave: "sine", harm: 0.18, harmRatio: 4, a: 0.003 },
      { t: 0.09, d: 0.32, f0: 1318.5, f1: 1318.5, g: 0.36, wave: "sine", harm: 0.18, harmRatio: 4, a: 0.003 },
      { t: 0.18, d: 0.6, f0: 1568, f1: 1568, g: 0.4, wave: "sine", harm: 0.18, harmRatio: 4, a: 0.003 },
    ],
  };
  /** The notes of a sound for a role: [{t, d, f0, f1, g, wave, a, vib, fm, lp, harm, harmRatio}], or null. */
  function recipe(name, role) {
    var src, v = null;
    if (Object.prototype.hasOwnProperty.call(KEY_RECIPES, name)) src = KEY_RECIPES[name];
    else if (Object.prototype.hasOwnProperty.call(SHAPES, name)) { src = SHAPES[name]; v = ROLES[roleOf(role)]; }
    else return null;
    return src.map(function (n) {
      var o = { t: n.t, d: n.d, f0: n.f0, f1: n.f1, g: n.g, wave: n.wave || "sine", a: n.a || 0.008, vib: n.vib || null, fm: n.fm || null, lp: n.lp || 0, harm: n.harm || 0, harmRatio: n.harmRatio || 2 };
      if (v) {
        o.f0 *= v.pitch; o.f1 *= v.pitch; o.wave = v.wave;
        if (v.lp) o.lp = v.lp;
        if (v.harm) o.harm = v.harm;
        if (v.fm) o.fm = { ratio: v.fm.ratio, index: v.fm.index, decay: 0 };
        if (v.wave === "square") o.g *= 0.8; // a square is louder for the same peak
      }
      return o;
    });
  }
  function recipeLength(notes) { var e = 0; (notes || []).forEach(function (n) { e = Math.max(e, n.t + n.d); }); return e; }
  /** The master gain for a volume (0-100): a curve, so the low end stays usable; 30 % is quiet. */
  function gainFor(vol) { var x = Math.max(0, Math.min(100, Number(vol) || 0)) / 100; return 0.6 * x * x; }

  /* ------------------------------------------------------------------ the limiter (pure; a clock goes in) */
  /**
   * offer(ev, t) -> "held" (it waits for the merge window), "merged" (a more important one waits),
   * "cooldown" or "rate"; flush(t) -> the event to play now, or null; played(ev, t) notes a sound that
   * played (here or in another tab); due() -> when flush should run (ms) or 0.
   */
  function Limiter() {
    this.pending = null; this.dueAt = 0; this.last = 0; this.recent = []; this.byKey = {}; this.merged = 0;
  }
  Limiter.prototype.keyOf = function (ev) { return ev.name + ":" + (PRIORITY[ev.name] && SHAPES[ev.name] ? roleOf(ev.role) : ""); };
  Limiter.prototype.blocked = function (ev, t) {
    var k = this.keyOf(ev), lk = this.byKey[k];
    if (lk && t - lk < COOLDOWN[ev.name]) return "cooldown";
    this.recent = this.recent.filter(function (x) { return t - x < BUDGET_MS; });
    if (this.recent.length >= BUDGET) return "rate";
    return "";
  };
  Limiter.prototype.offer = function (ev, t) {
    var b = this.blocked(ev, t);
    if (b) return b;
    ev.at = t;
    if (!this.pending) {
      this.pending = ev;
      this.dueAt = Math.max(t + MERGE_MS, this.last + GAP_MS);
      return "held";
    }
    this.merged++;
    if (PRIORITY[ev.name] > PRIORITY[this.pending.name]) { this.pending = ev; return "held"; }
    return "merged";
  };
  Limiter.prototype.due = function () { return this.pending ? this.dueAt : 0; };
  Limiter.prototype.flush = function (t) {
    var ev = this.pending;
    if (!ev || t < this.dueAt) return null;
    this.pending = null;
    if (t - ev.at > MAX_AGE_MS) return null;                     // held too long: it no longer says anything
    if (t - this.last < GAP_MS) { this.pending = ev; this.dueAt = this.last + GAP_MS; return null; } // another tab played meanwhile
    if (this.blocked(ev, t)) return null;
    return ev;
  };
  Limiter.prototype.played = function (ev, t) {
    this.last = Math.max(this.last, t);
    this.recent.push(t);
    this.byKey[this.keyOf(ev)] = t;
  };

  /* ------------------------------------------------------------------ an engine (one per page) */
  /**
   * create(env): env = { now() ms, date() Date, AudioContext, storage (localStorage-like), doc (gesture
   * listeners), setTimeout, clearTimeout }. The page uses create(window defaults); tests hand in fakes.
   */
  function create(env) {
    env = env || {};
    var now = env.now || function () { return Date.now(); };
    var dateNow = env.date || function () { return new Date(now()); };
    var setT = env.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var clearT = env.clearTimeout || function (h) { clearTimeout(h); };
    var store = env.storage || null;
    var AC = env.AudioContext || null;
    var TAB = Math.random().toString(36).slice(2, 10);
    var prefs = normSoundPrefs(""), host = { desktop: false, dnd: false }, probes = [], holds = [], lim = new Limiter();
    var ctx = null, unlocked = false, timer = 0, log = [], gestureOn = false, seenOther = 0;
    function sget(k) { try { return store ? store.getItem(k) : null; } catch (e) { return null; } }
    function sset(k, v) { try { if (store) store.setItem(k, v); } catch (e) { /* storage blocked: this tab only */ } }
    function note(r) { log.push(r); if (log.length > 40) log.shift(); return r; }
    function browserOn() { return sget("joya-sound-browser") === "1"; }
    /** Why it would be silent now (before the limiter), or "". */
    function silentWhy() {
      if (!prefs.on) return "off";
      if (!host.desktop && !browserOn()) return "browser";
      if (host.dnd) return "dnd";
      if (prefs.quiet && inQuietHours(dateNow(), prefs.from, prefs.to)) return "quiet";
      for (var i = 0; i < probes.length; i++) { var r = ""; try { r = probes[i](); } catch (e) { r = ""; } if (r) return typeof r === "string" ? r : "muted"; }
      if (!unlocked) return "locked";
      return "";
    }
    /* ---- the audio context, unlocked by a gesture */
    function ensureCtx() {
      if (ctx || !AC) return ctx;
      try { ctx = new AC({ latencyHint: "interactive" }); } catch (e) { ctx = null; }
      if (ctx && ctx.addEventListener) try { ctx.addEventListener("statechange", function () { if (ctx.state === "running") setUnlocked(); }); } catch (e) { /* old engine */ }
      return ctx;
    }
    function setUnlocked() { if (unlocked) return; unlocked = true; offGesture(); }
    function unlock() {
      var c = ensureCtx();
      if (!c) return Promise.resolve(false);
      if (c.state === "running") { setUnlocked(); return Promise.resolve(true); }
      var p;
      try { p = c.resume ? c.resume() : null; } catch (e) { p = null; }
      return Promise.resolve(p).then(function () { if (c.state === "running") setUnlocked(); return unlocked; }, function () { return false; });
    }
    var GESTURES = ["pointerdown", "keydown", "touchend"];
    function onGesture() { unlock(); }
    function onGestureList(add) {
      var d = env.doc;
      if (!d || !d.addEventListener) return;
      GESTURES.forEach(function (g) { try { d[add ? "addEventListener" : "removeEventListener"](g, onGesture, true); } catch (e) { /* no listener */ } });
    }
    function onGestureOn() { if (gestureOn || unlocked) return; gestureOn = true; onGestureList(true); }
    function offGesture() { if (!gestureOn) return; gestureOn = false; onGestureList(false); }
    onGestureOn();

    /* ---- playing a recipe through WebAudio */
    function voice(c, out, n, t0) {
      var t = t0 + n.t, end = t + n.d;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = n.wave;
      osc.frequency.setValueAtTime(n.f0, t);
      if (n.f1 !== n.f0) osc.frequency.exponentialRampToValueAtTime(n.f1, end);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(n.g, t + n.a);
      g.gain.exponentialRampToValueAtTime(0.0008, end);
      var node = osc, extra = [];
      if (n.lp) { var lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = n.lp; osc.connect(lp); node = lp; }
      node.connect(g); g.connect(out);
      if (n.vib) {
        var lfo = c.createOscillator(), lg = c.createGain();
        lfo.frequency.value = n.vib.rate; lg.gain.value = n.vib.depth * n.f0;
        lfo.connect(lg); lg.connect(osc.frequency); extra.push(lfo);
      }
      if (n.fm) {
        var mod = c.createOscillator(), mg = c.createGain(), dev = n.fm.index * n.f0;
        mod.frequency.value = n.f0 * n.fm.ratio;
        mg.gain.setValueAtTime(dev, t);
        if (n.fm.decay) mg.gain.exponentialRampToValueAtTime(Math.max(1, dev * 0.02), t + n.fm.decay);
        mod.connect(mg); mg.connect(osc.frequency); extra.push(mod);
      }
      if (n.harm) {
        var h = c.createOscillator(), hg = c.createGain();
        h.type = "sine"; h.frequency.setValueAtTime(n.f0 * n.harmRatio, t);
        if (n.f1 !== n.f0) h.frequency.exponentialRampToValueAtTime(n.f1 * n.harmRatio, end);
        hg.gain.setValueAtTime(0, t); hg.gain.linearRampToValueAtTime(n.g * n.harm, t + n.a);
        hg.gain.exponentialRampToValueAtTime(0.0008, t + n.d * 0.6);
        h.connect(hg); hg.connect(out); extra.push(h);
      }
      [osc].concat(extra).forEach(function (o) { o.start(t); o.stop(end + 0.02); });
    }
    function render(name, role) {
      var c = ctx, notes = recipe(name, role);
      if (!c || !notes) return false;
      try {
        var out = c.createGain(), t0 = c.currentTime + 0.01;
        out.gain.value = gainFor(prefs.vol);
        out.connect(c.destination);
        notes.forEach(function (n) { voice(c, out, n, t0); });
        setT(function () { try { out.disconnect(); } catch (e) { /* gone */ } }, (recipeLength(notes) + 0.3) * 1000);
        return true;
      } catch (e) { return false; }
    }
    /* ---- the queue: merge, space, then play */
    function schedule() {
      clearT(timer);
      var due = lim.due();
      if (!due) return;
      timer = setT(flush, Math.max(0, due - now()));
    }
    function otherTabLast() {
      var v = null;
      try { v = JSON.parse(sget("joya-sound-last") || "null"); } catch (e) { v = null; }
      return v && v.tab !== TAB && typeof v.t === "number" ? v : null;
    }
    function flush() {
      var t = now(), o = otherTabLast();
      if (o && o.t !== seenOther) { seenOther = o.t; lim.played({ name: o.name, role: o.role }, o.t); }
      var ev = lim.flush(t);
      if (ev) {
        var why = silentWhy(); // things may have changed while it waited (a call started)
        if (why) note({ name: ev.name, role: ev.role, why: why, t: t });
        else if (render(ev.name, ev.role)) {
          lim.played(ev, t);
          sset("joya-sound-last", JSON.stringify({ tab: TAB, t: t, name: ev.name, role: ev.role || "" }));
          note({ name: ev.name, role: ev.role, why: "played", t: t });
          if (env.onPlay) try { env.onPlay(ev); } catch (e) { /* a check's hook */ }
        }
      }
      schedule();
    }
    var api = {
      NAMES: NAMES, CHIRPS: CHIRPS, KEYS: KEYS, ROLES: ROLES,
      /** A sound, if it may play: { ok, why } -- why "held" (it plays after the merge window) or why not. */
      play: function (name, o) {
        o = o || {};
        if (NAMES.indexOf(name) < 0) return note({ ok: false, name: name, why: "unknown" });
        var role = SHAPES[name] ? roleOf(o.role) : "";
        // Eye contact (joya-presence-bind.js): you are away -- kept for the one sound of the summary when you are
        // back (which asks again then: quiet hours, a call, sounds off still silence it).
        for (var h = 0; h < holds.length; h++) { var held = false; try { held = holds[h](name, role); } catch (e) { held = false; } if (held) return note({ ok: false, name: name, role: role, why: "away", t: now() }); }
        var why = silentWhy();
        if (why) return note({ ok: false, name: name, role: role, why: why, t: now() });
        var r = lim.offer({ name: name, role: role }, now());
        if (r === "held") schedule();
        return note({ ok: r === "held", name: name, role: role, why: r, t: now() });
      },
      /** The Settings preview: now, at the chosen volume (needs the audio unlocked: the click that asks does that). */
      preview: function (name, o) {
        if (NAMES.indexOf(name) < 0) return false;
        return unlock().then(function (ok) { return ok && render(name, SHAPES[name] ? roleOf(o && o.role) : ""); });
      },
      unlock: unlock,
      unlocked: function () { return unlocked; },
      setPrefs: function (p) { prefs = normSoundPrefs(p); return prefs; },
      prefs: function () { return normSoundPrefs(prefs); },
      /** What the host says: { desktop } (the desktop app's page), { dnd } (its do-not-disturb, Windows Focus). */
      setHost: function (h) {
        h = h || {};
        if (h.desktop !== undefined) host.desktop = !!h.desktop;
        if (h.dnd !== undefined) host.dnd = !!h.dnd;
        if (host.desktop && !unlocked && h.probe !== false) { var c = ensureCtx(); if (c && c.state === "running") setUnlocked(); }
      },
      host: function () { return { desktop: host.desktop, dnd: host.dnd }; },
      /** This browser's own switch (a plain browser is silent until it is on). */
      setBrowserOn: function (on) { sset("joya-sound-browser", on ? "1" : "0"); },
      browserOn: browserOn,
      /** A probe that silences it while it returns a reason (a live call, the voice speaking). */
      mutedBy: function (fn) { if (typeof fn === "function") probes.push(fn); },
      /** A hook that takes a sound for later (returns true: held, not played now) -- eye contact's "away". */
      heldBy: function (fn) { if (typeof fn === "function") holds.push(fn); },
      silentWhy: silentWhy,
      /** The last decisions (for checks and the console). */
      log: function () { return log.slice(); },
      _limiter: lim,
    };
    return api;
  }

  var M = {
    DEFAULTS: DEFAULTS, NAMES: NAMES, CHIRPS: CHIRPS, KEYS: KEYS, ROLES: ROLES, PRIORITY: PRIORITY, COOLDOWN: COOLDOWN,
    MERGE_MS: MERGE_MS, GAP_MS: GAP_MS, MAX_AGE_MS: MAX_AGE_MS, BUDGET: BUDGET, BUDGET_MS: BUDGET_MS,
    normSoundPrefs: normSoundPrefs, soundPrefsJson: soundPrefsJson, checkSoundEdit: checkSoundEdit, applySoundEdit: applySoundEdit,
    soundPrefsLine: soundPrefsLine, inQuietHours: inQuietHours, recipe: recipe, recipeLength: recipeLength, gainFor: gainFor, roleOf: roleOf,
    Limiter: Limiter, create: create,
  };
  if (typeof module === "object" && module.exports) module.exports = M;
  if (typeof window !== "undefined" && !window.JoyaSound) {
    var eng = create({ AudioContext: window.AudioContext || window.webkitAudioContext, storage: (function () { try { return window.localStorage; } catch (e) { return null; } })(), doc: document });
    Object.keys(M).forEach(function (k) { if (eng[k] === undefined) eng[k] = M[k]; });
    window.JoyaSound = eng;
  }
})();
