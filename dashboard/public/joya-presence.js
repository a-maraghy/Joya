"use strict";
/*
 * Eye contact (2026-10-20; mockups/eye-contact/DESIGN.md): the camera module. Off unless the person switched
 * "Camera presence" on (Settings > Appearance > Eye contact in a browser -- per browser; the app's Settings
 * or tray in the desktop app); joya-presence-bind.js decides that and hands the module its host's state.
 *
 * What it does with the camera, all of it here and in joya-presence-worker.js:
 *   - opens it small (320 x 240) and reads it slowly: 5 frames a second, 2 on battery / in energy saver /
 *     while nobody is there (12, 8 on battery, while you face the bot with look and speak on: the lips move faster
 *     than 5 frames a second can see -- 2026-10-22); it lets go of it at once when switched off, the screen locked, another app holds a
 *     meeting, or (by default) in energy saver -- and when the page has been hidden for 10 s (never opened hidden);
 *   - hands each frame to the worker (transferred -- no copy is kept) which runs the face model on this
 *     computer and answers with a few numbers per face; JoyaPresenceLogic turns them into the state.
 *
 * What leaves this module (JoyaPresence.on / snapshot): the state ("present" | "looking" | "away", or null
 * while the camera is off), a coarse direction for the bot's eyes ({x, y} in quarters), and whether the
 * camera is in use (for the indicator and the app's tray). No frame, image, landmark or face record ever
 * does: they live in this closure and the worker, and nothing here makes a network request. The frames are
 * not stored anywhere.
 *
 * Look and speak (its own switch, off by default): while the person faces the bot (frontal, nobody else in
 * view) the microphone is open here -- a level meter, and the last 2.5 s of audio in memory, overwritten as it
 * goes (nothing is kept or sent unless a turn starts) -- and speech starting then (with their own mouth moving)
 * calls hooks.speak({ preroll }), which starts a voice turn the way the talk key does, with the audio from just
 * before the speech began (so its first words are in the turn); this microphone feeds the turn (hooks.feed)
 * until the voice's own is flowing. Holding the look warms the voice up first (hooks.warm). A reply that is playing pauses after ~1.5 s looking away (hooks.pause(true)) and resumes on looking
 * back. A small "Camera on" pill shows while the camera is open; its button switches it off (hooks.off).
 *
 * Which camera (2026-10-21): the one chosen in Settings > Appearance > Eye contact (localStorage
 * "joya-presence-camera" = { id, label }, this browser's / app's own, never sent), else Automatic -- the
 * built-in camera, never a phone (Phone Link) or virtual one unless it is all there is
 * (JoyaPresenceLogic.pickCamera). If the chosen one is gone or fails, Automatic, and the state's why and
 * Settings say so (localStorage "joya-presence-cam-used": the camera in use, local only). A camera plugged in
 * or out (devicechange) is looked at again.
 *
 *   JoyaPresence.configure({ prefs: {cam, speak, saver}, host: {hidden, locked, meeting, saver, battery}, bot: {x, y}, camera: {id, label} | null })
 *   JoyaPresence.on(fn)          fn({ state, gaze, camera }) on every change
 *   JoyaPresence.snapshot()      { state, gaze, camera, why }
 *   JoyaPresence.device()        the camera in use: { label, name, how, note } (null while closed)
 *   JoyaPresence.hooks({ speak, busy, speaking, pause, off, ready, feed, warm })   ready(): can a voice turn start at all (voice on)?
 *                                speak({ preroll }) -> a turn opened?; feed({ pcm, level }) -> keep feeding it?; warm(): open the call ahead
 *   JoyaPresence.look()          look and speak's checklist, numbers only ("Show what it sees" in Settings)
 *   JoyaPresence.release(why)    let go of the camera now
 *   JoyaPresence.diag()          counts only (frames, fps, ms per frame, opened, released, why)
 *   JoyaPresence.indication()    what the page shows now (JoyaPresenceLogic.indication; null while closed)
 *   JoyaPresence.note(text, ms)  a short note in the pill's words for a moment (a voice not recognised)
 *
 * Indications (2026-10-21, mockups/eye-contact/indicators): the pill says what it sees ("Watching" / "You're
 * here" / "Looking at me", "Listening", "Paused") and, on hover or a tap, why look and speak waits (voice off,
 * busy, cool-down, someone else in view); hooks.ind(indication) hands the same record to joya-presence-bind.js,
 * which draws the ring on the bot (noticed / the 0.6 s hold filling / ready) and the caption under it. All of it
 * is drawn from this module's own state; none of it is sent anywhere.
 */
(function () {
  var Logic = window.JoyaPresenceLogic;
  if (!Logic || window.JoyaPresence) return;
  var me = document.currentScript && document.currentScript.src;
  // Next to this file, unstamped (kept 5 minutes, then revalidated): its own CSP comes with it (server.js).
  var WORKER = me ? new URL("joya-presence-worker.js", me).pathname : "/static/joya-presence-worker.js";
  var W = 320, H = 240;

  var cfg = { prefs: Logic.normPrefs(null), host: {}, bot: null, camera: null, show: false };
  var USED = "joya-presence-cam-used";
  var H_ = { speak: null, busy: null, speaking: null, pause: null, off: null, ready: null, listening: null, ind: null, feed: null, warm: null };
  var turns = { tried: 0, opened: 0, refused: 0, last: null }; // look and speak's starts (for "Show what it sees")
  var subs = [];
  var C = { stream: null, video: null, worker: null, ready: false, inflight: false, timer: 0, fps: 0, opening: false, denied: false, lostAt: 0, why: "off", dev: null, note: "", failed: [], gen: 0 };
  var tracker = Logic.createTracker({ bot: null });
  var gate = Logic.createSpeakGate();
  var rp = Logic.createReplyPause();
  var pub = { state: null, gaze: null, camera: false };
  var diag = { frames: 0, faces: 0, ms: 0, opened: 0, released: 0, why: "off", errors: 0 };
  var mic = { stream: null, ctx: null, an: null, buf: null, t: 0, offAt: 0, cap: null, src: null, ring: [], bridge: 0, warmLook: false, warmAt: -1e12 };

  function call(fn, a) { try { return fn ? fn(a) : undefined; } catch (e) { return undefined; } }
  function emit() { subs.slice().forEach(function (fn) { call(fn, { state: pub.state, gaze: pub.gaze, camera: pub.camera }); }); }
  function setPub(state, gaze, camera) {
    var g = gaze ? { x: gaze.x, y: gaze.y } : null;
    var same = state === pub.state && camera === pub.camera && (g === pub.gaze || (g && pub.gaze && g.x === pub.gaze.x && g.y === pub.gaze.y));
    pub = { state: state, gaze: g, camera: camera };
    if (!same) emit();
  }

  /* ---------------------------------------------------------------- the indicator */
  var pill = null, openT = 0;
  function indicator(on) {
    if (on && !pill) {
      pill = document.createElement("div");
      pill.className = "mp-cam";
      pill.id = "mp-cam";
      pill.setAttribute("role", "status");
      pill.setAttribute("aria-describedby", "mp-why");
      // the state word, the camera, a quiet "i" while look and speak waits, Off; the hint under it (hover / focus / a tap)
      pill.innerHTML = '<span class="mp-dot" aria-hidden="true"></span><span class="mp-s"></span><span class="mp-t">Camera on · eye contact</span>' +
        '<span class="mp-i" aria-hidden="true">i</span><button type="button" class="mp-off" aria-label="Switch camera presence off">Off</button>' +
        '<span class="mp-why" id="mp-why" role="tooltip"><span class="mp-why-s"></span><span class="mp-why-c"></span></span>';
      pill.querySelector(".mp-off").addEventListener("click", function () { release("switched off"); call(H_.off); });
      // A tap (touch, or a click in the app) opens the hint for a few seconds; another closes it.
      pill.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".mp-off")) return;
        clearTimeout(openT);
        var o = !pill.classList.contains("mp-open");
        pill.classList.toggle("mp-open", o);
        if (o) openT = setTimeout(function () { if (pill) pill.classList.remove("mp-open"); }, 6000);
      });
      (document.body || document.documentElement).appendChild(pill);
    } else if (!on && pill) { pill.remove(); pill = null; clearTimeout(openT); }
    if (pill) {
      var name = C.dev && Logic.shortCam(C.dev.label);
      var ind = curInd;
      pill.querySelector(".mp-t").textContent = name ? "Camera on · " + name : "Camera on · eye contact";
      pill.querySelector(".mp-s").textContent = noteNow() || (ind ? ind.word : "Watching");
      pill.classList.toggle("mp-noted", !!noteNow());
      pill.setAttribute("data-look", ind ? ind.look : "watching");
      pill.setAttribute("data-cap", (ind && ind.caption) || "");
      pill.classList.toggle("mp-blocked", !!(ind && ind.blocked));
      pill.querySelector(".mp-why-s").textContent = Logic.speakHint(ind, !!cfg.prefs.speak);
      pill.querySelector(".mp-why-c").textContent = (C.dev && C.dev.label ? "Camera: " + Logic.camLabel(C.dev.label) + (C.note ? " (" + C.note + ")" : "") + ". " : "") +
        "Nothing leaves this computer.";
    }
    document.documentElement.classList.toggle("mp-cam-on", !!on);
  }

  // a short note on the pill for a moment (JoyaPresence.note: "Didn't recognise your voice, try again"); the pill is a
  // status region (polite), so it is read out once
  var note = { text: "", until: 0, t: 0 };
  function noteNow() { return note.text && performance.now() < note.until ? note.text : ""; }

  /* ---------------------------------------------------------------- the indications (2026-10-21) */
  var curInd = null, indSig = "null", lastS = null, heardAt = 0, indT = 0;
  function listeningNow() {
    if (!heardAt) return false;
    var l = H_.listening ? !!call(H_.listening) : performance.now() - heardAt < 8000;
    if (!l || performance.now() - heardAt > 60000) heardAt = 0;
    return !!heardAt;
  }
  function refreshInd() {
    var ind = null;
    if (C.stream) {
      var g = gate.status(performance.now()), s = lastS || {};
      ind = Logic.indication({
        camera: true, state: pub.state, atBot: !!s.atBot, speakOn: !!cfg.prefs.speak, voice: voiceReady(), busy: !!call(H_.busy),
        others: s.others || 0, coolLeft: g.coolLeft, held: g.held, armMs: g.armMs, armed: g.armed, paused: rp.paused(), listening: listeningNow(),
      });
    }
    var sig = JSON.stringify(ind);
    if (sig === indSig) return;
    indSig = sig; curInd = ind;
    if (pill) indicator(true);
    call(H_.ind, ind);
  }

  /** Can look and speak start a voice turn here? (No hook: assume it can.) Voice off -> it says so instead of nothing. */
  function voiceReady() { if (!H_.ready) return true; return !!call(H_.ready); }

  /* ---------------------------------------------------------------- the camera */
  // Facing the bot with look and speak on (or "Show what it sees" open): the camera reads 12 frames a second (8 on
  // battery) so the lips are seen moving, and keeps that FACING_HOLD_MS after the look ends (no flapping).
  var facingUntil = 0, FACING_HOLD_MS = 1500;
  function want() {
    var h = cfg.host || {};
    return Logic.rate({ on: cfg.prefs.cam && !C.denied, hidden: hiddenLong() || h.hidden, locked: h.locked, meeting: h.meeting, saver: h.saver, releaseOnSaver: cfg.prefs.saver, battery: h.battery, state: pub.state,
      facing: performance.now() < facingUntil });
  }
  function apply() {
    var r = want();
    C.why = r.why; diag.why = r.why;
    if (!r.fps) { if (C.stream || C.opening) release(r.why); else setPub(null, null, false); return; }
    C.fps = r.fps;
    if (!C.stream && !C.opening) open();
  }
  function videoC(id) {
    var v = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: 15, max: 30 } };
    if (id) v.deviceId = { exact: id }; else v.facingMode = "user";
    return { audio: false, video: v };
  }
  function devices() {
    var md = navigator.mediaDevices;
    if (!md.enumerateDevices) return Promise.resolve([]);
    return md.enumerateDevices().then(function (l) { return l || []; }, function () { return []; });
  }
  function stopAll(stream) { stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); }); }
  function idOf(stream) { var t = stream.getVideoTracks()[0], s = t && t.getSettings ? t.getSettings() : null; return (s && s.deviceId) || ""; }
  function used() { // what Settings shows ("in use: ..."): on this computer only
    try { window.localStorage.setItem(USED, JSON.stringify({ label: C.dev ? Logic.camLabel(C.dev.label) : "", how: C.dev ? C.dev.how : "", note: C.note, t: Date.now() })); } catch (e) { /* no storage */ }
  }
  function open() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.Worker || !window.createImageBitmap) { C.why = diag.why = "unsupported"; return; }
    if (C.lostAt && Date.now() - C.lostAt < 30000) return;
    C.opening = true;
    var gen = ++C.gen;
    devices().then(function (devs) { tryOpen(gen, Logic.pickCamera(devs, cfg.camera, { avoid: C.failed }), 0); });
  }
  function tryOpen(gen, pick, n) {
    if (gen !== C.gen) return;
    navigator.mediaDevices.getUserMedia(videoC(pick.id)).then(function (stream) {
      if (gen !== C.gen || !want().fps) { stopAll(stream); if (gen === C.gen) C.opening = false; return; }
      if (pick.id || n) return opened(stream, pick);
      // Opened before the labels were known (the first time): now they are -- the right camera, if this is not it.
      devices().then(function (devs) {
        if (gen !== C.gen) { stopAll(stream); return; }
        var p2 = Logic.pickCamera(devs, cfg.camera, { avoid: C.failed }), cur = idOf(stream);
        if (p2.id && cur && p2.id !== cur) { stopAll(stream); tryOpen(gen, p2, n + 1); return; }
        var here = devs.filter(function (d) { return d.kind === "videoinput" && d.deviceId === cur; })[0];
        opened(stream, here ? { id: cur, label: here.label, how: p2.id === cur ? p2.how : "default", note: p2.note } : p2);
      });
    }, function (e) {
      if (gen !== C.gen) return;
      var nm = e && e.name;
      if (nm === "NotAllowedError" || nm === "SecurityError") { C.opening = false; C.denied = true; C.why = diag.why = "denied"; diag.errors++; setPub(null, null, false); return; }
      if (pick.id && n < 6) { // this camera would not open (gone, busy, refused the size): the next best one
        C.failed.push(pick.id); diag.errors++;
        devices().then(function (devs) {
          var p2 = Logic.pickCamera(devs, cfg.camera, { avoid: C.failed });
          if (!p2.note && pick.how !== "auto" && pick.how !== "default") p2.note = (Logic.shortCam(pick.label, 40) || "The camera you chose") + " could not be opened — using Automatic";
          else if (!p2.note && pick.how === "auto") p2.note = (Logic.shortCam(pick.label, 40) || "A camera") + " could not be opened";
          tryOpen(gen, p2, n + 1);
        });
        return;
      }
      // A refusal (the browser's prompt, or the app's policy) is final until the switch is turned on again.
      C.opening = false;
      C.lostAt = Date.now(); C.why = diag.why = "no camera";
      diag.errors++;
      setPub(null, null, false);
    });
  }
  function opened(stream, pick) {
    C.opening = false;
    C.stream = stream; diag.opened++;
    C.dev = { id: idOf(stream) || pick.id || "", label: pick.label || "", how: pick.how };
    C.note = pick.note || "";
    used();
    stream.getVideoTracks().forEach(function (t) { t.onended = function () { C.lostAt = Date.now(); release("camera lost"); }; });
    var v = document.createElement("video"); // never in the page: nobody sees it, nothing draws it
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.srcObject = stream;
    var p = v.play(); if (p && p.catch) p.catch(function () { /* plays once it can */ });
    C.video = v;
    indicator(true);
    setPub(pub.state, pub.gaze, true);
    clearInterval(indT); indT = setInterval(refreshInd, 200); // busy / listening / cool-down move between frames
    refreshInd();
    startWorker();
    loop();
  }
  /** Another camera now (the choice changed, or one was plugged in / out): let go and open the right one. */
  function reopen(why) {
    C.failed = []; C.lostAt = 0;
    if (C.stream || C.opening) release(why);
    apply();
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", function () {
    if (!cfg.prefs.cam) return;
    if (!C.stream) { if (C.lostAt && !C.opening) { C.lostAt = 0; apply(); } return; }
    devices().then(function (devs) {
      if (!C.stream || !C.dev) return;
      var p = Logic.pickCamera(devs, cfg.camera, {}), here = devs.some(function (d) { return d.kind === "videoinput" && d.deviceId === C.dev.id; });
      if (!here || (p.id && p.id !== C.dev.id)) reopen("camera changed");
    });
  });
  function startWorker() {
    if (C.worker) return;
    try { C.worker = new Worker(WORKER); } catch (e) { diag.errors++; return; }
    C.ready = false; C.inflight = false;
    C.worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === "ready") { C.ready = true; return; }
      if (m.type === "error") { diag.errors++; diag.why = "model: " + m.message; return; }
      if (m.type === "faces") { C.inflight = false; if (m.faces) frame(m.faces, m.ms); }
    };
    C.worker.onerror = function () { diag.errors++; };
    C.worker.postMessage({ type: "init" });
  }
  function loop() {
    clearTimeout(C.timer);
    if (!C.stream) return;
    C.timer = setTimeout(loop, Math.round(1000 / (C.fps || 5)));
    var v = C.video;
    if (!C.ready || C.inflight || !v || v.readyState < 2) return;
    C.inflight = true;
    createImageBitmap(v, { resizeWidth: W, resizeHeight: H, resizeQuality: "low" }).then(function (bmp) {
      if (!C.worker) { bmp.close(); C.inflight = false; return; }
      C.worker.postMessage({ type: "frame", bmp: bmp, t: performance.now() }, [bmp]);
    }, function () { C.inflight = false; });
  }
  function frame(faces, ms) {
    diag.frames++; diag.ms = ms; if (faces.length) diag.faces++;
    var s = tracker.push(faces, performance.now());
    lastS = s;
    gate.vision(s, performance.now());
    var r = rp.feed(s.turnedAwayMs, s.state === "looking", !!call(H_.speaking));
    if (r) call(H_.pause, r === "pause");
    speakMic(s);
    if ((s.facingNow || s.atBot) && !s.others && (cfg.prefs.speak || cfg.show)) facingUntil = performance.now() + FACING_HOLD_MS;
    setPub(s.state, s.gaze, true);
    var f = want().fps;
    if (f && f !== C.fps) { var up = f > C.fps; C.fps = f; if (up) loop(); } // faster at once; slower from the next frame
    refreshInd();
  }
  function release(why) {
    clearTimeout(C.timer);
    C.gen++; C.opening = false; C.dev = null;
    if (C.stream) { C.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); }); diag.released++; }
    C.stream = null;
    if (C.video) { C.video.srcObject = null; C.video = null; }
    if (C.worker) { try { C.worker.postMessage({ type: "close" }); } catch (e) { /* gone */ } C.worker.terminate(); C.worker = null; }
    C.ready = false; C.inflight = false;
    C.why = diag.why = why || "off";
    micOff();
    var r = rp.reset(); if (r) call(H_.pause, false);
    tracker.reset();
    lastS = null; heardAt = 0; clearInterval(indT); indT = 0;
    indicator(false);
    setPub(null, null, false);
    refreshInd();
  }

  /* ---------------------------------------------------------------- look and speak: the microphone */
  /*
   * While a face looks at the bot the microphone is open here: a level meter (the gate's onset) and, since
   * 2026-10-21 ("slow, inaccurate": a turn lost its first ~0.6-1 s -- the 160 ms onset, then this microphone
   * closed and the voice's own opened, set up and started relaying), a ring of the last RING_MS (2.5 s) of audio in
   * memory (24 kHz PCM16 frames from the voice's own capture worklet, overwritten as it goes; nothing is kept
   * or sent while nobody speaks). When a turn starts, the ring from just before the speech began goes with it
   * (the pre-roll, hooks.speak({ preroll })), and this microphone keeps feeding the turn (hooks.feed) until the
   * voice's own is flowing, then closes. A look that arms look and speak warms the voice up (hooks.warm: the
   * call opens before anyone speaks), at most once per look and once per WARM_GAP_MS.
   */
  var RING_MS = 2500, PREROLL_MS = 1200, PRE_BEFORE_MS = 400, BRIDGE_MAX_MS = 5000, WARM_GAP_MS = 8000;
  var WORKLET = (function () { var el = document.querySelector("[data-live-worklet]"); return (el && el.getAttribute("data-live-worklet")) || "/static/voice-live-worklet.js"; })();
  function speakMic(s) {
    if ((!cfg.prefs.speak && !cfg.show) || !C.stream || (!voiceReady() && !cfg.show)) { micOff(); return; }
    if (mic.bridge) { if (performance.now() - mic.bridge > BRIDGE_MAX_MS) micOff(); return; } // feeding a turn that just started: closed when the voice's own microphone flows
    var busy = !!call(H_.busy);
    var facing = !!(s.atBot && s.speak);
    if ((facing || (s.facingNow && cfg.prefs.speak) || (cfg.show && s.face && s.state === "looking")) && !s.others && !busy) { mic.offAt = 0; micOn(); }
    else if (mic.stream) { if (!mic.offAt) mic.offAt = performance.now(); else if (performance.now() - mic.offAt > 2000) micOff(); }
    // warm the voice up: armed (the 0.6 s look held), look and speak on, nothing going on
    if (!facing) mic.warmLook = false;
    else if (gate.armed() && !mic.warmLook && !busy && cfg.prefs.speak && voiceReady() && !s.others && performance.now() - mic.warmAt > WARM_GAP_MS) {
      mic.warmLook = true;
      if (call(H_.warm)) mic.warmAt = performance.now();
    }
  }
  function micOn() {
    if (mic.stream || mic.opening) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    mic.opening = true;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }).then(function (st) {
      mic.opening = false;
      if (!C.stream || (!cfg.prefs.speak && !cfg.show)) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
      mic.stream = st;
      mic.ctx = new AC({ latencyHint: "interactive" });
      if (mic.ctx.state === "suspended" && mic.ctx.resume) mic.ctx.resume().catch(function () {});
      var src = (mic.src = mic.ctx.createMediaStreamSource(st));
      // 2048 samples (~43 ms): a level that does not flicker between the sounds of a word
      mic.an = mic.ctx.createAnalyser(); mic.an.fftSize = 2048;
      src.connect(mic.an); // to the meter: never to the speakers
      mic.buf = new Float32Array(mic.an.fftSize);
      mic.t = setInterval(meter, 50);
      mic.ring = [];
      var ctx = mic.ctx;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        ctx.audioWorklet.addModule(WORKLET).then(function () {
          if (mic.ctx !== ctx) return;
          var cap = (mic.cap = new AudioWorkletNode(ctx, "joya-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 }));
          cap.port.onmessage = function (e) { ringFrame(e.data || {}); };
          src.connect(cap);
        }).catch(function () { /* no pre-roll: the turn starts as before */ });
      }
    }, function () { mic.opening = false; });
  }
  /** A 20 ms frame from the capture worklet: into the ring; while a turn is being fed, to the turn. */
  function ringFrame(m) {
    if (m.type !== "frame" || !m.pcm) return;
    var t = performance.now(), f = { t: t, pcm: m.pcm, level: m.level || 0 };
    if (mic.bridge) {
      if (t - mic.bridge > BRIDGE_MAX_MS || !call(H_.feed, f)) { mic.bridge = 0; micOff(); }
      return;
    }
    mic.ring.push(f);
    while (mic.ring.length && t - mic.ring[0].t > RING_MS) mic.ring.shift();
  }
  function meter() {
    if (!mic.an || mic.bridge) return;
    mic.an.getFloatTimeDomainData(mic.buf);
    var now = performance.now();
    // is it a voice (periodic at a voice's pitch, harmonic, in speech's band)? -- numbers in memory, nothing kept
    var feat = Logic.vadFrame(mic.buf, mic.ctx ? mic.ctx.sampleRate : 48000);
    if (gate.audio(feat, now, !!call(H_.busy)) === "start") {
      turns.tried++;
      if (cfg.show && !cfg.prefs.speak) { turns.last = { t: Date.now(), ok: null }; return; } // Settings' readout: shown, not started
      // the pre-roll: from PRE_BEFORE_MS before the speech began (at least PREROLL_MS back), what the ring holds
      var on = gate.onset(), from = Math.min(now - PREROLL_MS, (on == null ? now : on) - PRE_BEFORE_MS);
      var pre = (mic.ring || []).filter(function (f) { return f.t >= from; });
      mic.ring = [];
      var r = voiceReady() ? call(H_.speak, { preroll: pre.map(function (f) { return f.pcm; }) }) : false;
      if (r === false || r === undefined || !mic.cap) micOff(); // no turn, or nothing to feed it with
      else mic.bridge = now; // keep feeding the turn until the voice's own microphone flows (hooks.feed says)
      if (r === false) turns.refused++; else { turns.opened++; heardAt = now; refreshInd(); }
      turns.last = { t: Date.now(), ok: r !== false, preMs: pre.length * 20 };
    }
  }
  function micOff() {
    clearInterval(mic.t); mic.t = 0;
    if (mic.cap) { try { mic.cap.port.onmessage = null; mic.cap.disconnect(); } catch (e) { /* gone */ } }
    if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
    if (mic.ctx && mic.ctx.close) mic.ctx.close().catch(function () {});
    mic.stream = null; mic.ctx = null; mic.an = null; mic.cap = null; mic.src = null; mic.ring = []; mic.bridge = 0; mic.offAt = 0;
  }

  // Hidden (another tab, minimised, a covered app window): let go once it has stayed hidden for HIDDEN_MS -- a quick
  // switch away and back does not flash the camera light off and on.
  var HIDDEN_MS = 10000, hiddenAt = Date.now(), hiddenT = 0, seenVisible = !document.hidden;
  function hiddenLong() { return !!(document.hidden && (!seenVisible || Date.now() - hiddenAt >= HIDDEN_MS)); } // never shown yet: not at all
  document.addEventListener("visibilitychange", function () {
    clearTimeout(hiddenT);
    if (document.hidden) { hiddenAt = Date.now(); hiddenT = setTimeout(apply, HIDDEN_MS + 50); } else { seenVisible = true; apply(); }
  });
  window.addEventListener("pagehide", function () { release("page closed"); });

  window.JoyaPresence = {
    configure: function (o) {
      o = o || {};
      if (o.prefs) {
        var p = Logic.normPrefs(o.prefs);
        if (p.cam && !cfg.prefs.cam) { C.denied = false; C.lostAt = 0; } // switched on again: ask again
        cfg.prefs = p;
      }
      if (o.host) cfg.host = Object.assign({}, cfg.host, o.host);
      if ("show" in o) cfg.show = !!o.show; // Settings' "Show what it sees": the level meter runs while a face looks
      if (o.bot) { cfg.bot = o.bot; tracker.setBot(o.bot); }
      if ("camera" in o) {
        var c = Logic.normCamChoice(o.camera);
        if (JSON.stringify(c) !== JSON.stringify(cfg.camera)) { cfg.camera = c; reopen("camera changed"); return; }
      }
      apply();
      if (C.stream) { indicator(true); refreshInd(); } // the pill's words follow the switches
    },
    on: function (fn) { if (typeof fn === "function") subs.push(fn); },
    snapshot: function () { return { state: pub.state, gaze: pub.gaze, camera: pub.camera, why: [C.why, C.stream ? C.note : ""].filter(Boolean).join("; ") }; },
    device: function () { return C.stream && C.dev ? { label: Logic.camLabel(C.dev.label), name: Logic.shortCam(C.dev.label), how: C.dev.how, note: C.note } : null; },
    hooks: function (h) { Object.keys(H_).forEach(function (k) { if (h && typeof h[k] === "function") H_[k] = h[k]; }); indicator(!!C.stream); indSig = ""; refreshInd(); },
    indication: function () { return curInd ? JSON.parse(JSON.stringify(curInd)) : null; },
    look: function () {
      var g = gate.status(performance.now());
      return Object.assign(g, { camera: !!C.stream, why: C.why, mic: !!mic.stream, fps: C.stream ? C.fps : 0, ms: diag.ms, speakOn: !!cfg.prefs.speak, voice: voiceReady(), busy: !!call(H_.busy), turns: Object.assign({}, turns, { last: turns.last && Object.assign({}, turns.last) }) });
    },
    /** A short note in the pill's words for ms (default 2.6 s), then its own word again. */
    note: function (text, ms) {
      clearTimeout(note.t);
      note.text = String(text || "").slice(0, 80); note.until = performance.now() + (ms || 2600);
      if (pill) indicator(true);
      note.t = setTimeout(function () { note.text = ""; if (pill) indicator(true); }, (ms || 2600) + 20);
    },
    release: function (why) { release(why || "released"); },
    /** Look and speak finished a turn (the voice went quiet): the gate waits its cool-down from now. */
    turnEnded: function () { gate.ended(performance.now()); },
    diag: function () { return { frames: diag.frames, withFace: diag.faces, ms: diag.ms, fps: C.stream ? C.fps : 0, opened: diag.opened, released: diag.released, why: diag.why, errors: diag.errors, mic: !!mic.stream, worker: !!C.worker, ready: C.ready }; },
  };
})();
