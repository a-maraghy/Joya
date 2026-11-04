/*
 * Live conversation (TRIAL): the page side, self-contained. See
 * lib/voice-live.js for the server and the README ("Live conversation") for
 * the integration contract any page can use:
 *
 *   VoiceLive.supported()            the browser can do it (getUserMedia + AudioWorklet + WebSocket)
 *   VoiceLive.start({ csrf, worklet, url?, duplex?, onState, onCaption, onLevel, onEvent }) -> Promise
 *   VoiceLive.stop(why?)             hang up; why (logged by the server): button,
 *                                    esc, mic, navigate, unload, track-ended,
 *                                    devicechange or error:<message>
 *   VoiceLive.mute(on) / .muted()    a hard mute: the microphone sends nothing
 *   VoiceLive.interrupt()            stop the voice now (a tap, Space or Esc)
 *   VoiceLive.pause(on) / .paused()  hold the reply where it is / go on (eye contact: looking away)
 *   VoiceLive.press(o) / .release()  hold-to-talk's key down / up; o.preroll: audio from just before (look and speak)
 *   VoiceLive.feed(pcm, level)       look and speak: another microphone feeds the turn until this one flows
 *   VoiceLive.duplex(mode?)          "speakers" (half-duplex: the microphone is
 *                                    not heard while the voice speaks) | "full"
 *                                    (headphones: talk over it)
 *   VoiceLive.active() / .state() / .speaking() / .route()
 *   VoiceLive.ack(nonce, ok, why)    answer a "ui" message (a screen action the voice asked for)
 *   VoiceLive.tell(m)                {type: "reply-shown", turn} / {type: "screen", path, title, panel}:
 *                                    what the page shows, for the voice (see tell below)
 *
 *   onState(state)     "connecting" | "listening" | "talking" | "thinking" |
 *                      "speaking" | "interrupted" | "waiting" | "muted" |
 *                      "ended" | "error"  ("waiting": working on a request, result pending)
 *   onCaption({who, text, final})   who: "you" | "desk" | "joya"
 *   onLevel({mic, out})             0..1-ish loudness, for the core
 *   onEvent(msg)                    every server message (asked, replied, stop, ended, error,
 *                                   reconnecting / reconnected: the upstream leg dropped and
 *                                   came back; restarting: the dashboard is restarting -- the
 *                                   call ends, and the page may start it again with
 *                                   {resume: "restart"}; mic-lost / mic-back)
 *
 * start({..., resume: "restart", lang: "ar"|"en"}) tells the server the call is
 * coming back after a restart, so the voice says it is back. The microphone's
 * track ending (unplugged, taken by another app) or a device change is caught:
 * the microphone is opened again once, and if that fails the call ends with
 * that reason. Leaving the page, the end reason also goes by navigator.sendBeacon.
 *
 * The microphone is opened with echo cancellation, noise suppression and
 * automatic gain; an AudioWorklet (voice-live-worklet.js, same origin) turns it
 * into 24 kHz PCM16 and streams it to this server's /joya-ai/api/live
 * WebSocket. What comes back is played through a second worklet that can be
 * flushed the moment the server says the administrator started talking; it
 * reports how many milliseconds of each segment were played, so the server
 * can cut the conversation exactly there. Nothing here talks to OpenAI.
 *
 * Echo-cancelled playback (2026-09-29: laptop speakers leaked into the
 * microphone and the voice interrupted itself). Chromium's echo canceller
 * does not reliably cover Web Audio output, only what WebRTC plays. So the
 * player's output goes into a MediaStream, through a local RTCPeerConnection
 * pair (loopback, never leaves the page) and plays from an <audio> element:
 * the canceller then knows it and removes it from the microphone. If that
 * cannot be set up, the player plays to the speakers directly ("direct").
 * The loopback adds its jitter buffer's delay, measured and subtracted from
 * the played milliseconds the server truncates at.
 *
 * The barge-in detector (voice-live-detect.js, loaded before this file) is fed
 * the microphone and output levels; its "on"/"off" go to the server, which
 * interrupts only when it and its own VAD agree.
 */
(function () {
  "use strict";
  var AC = window.AudioContext || window.webkitAudioContext;
  var S = null; // the running call
  var diag = (window.__joyaLive = { calls: 0, frames: 0, bytesIn: 0, segs: 0, flushes: [], states: [], captions: [], played: 0, errors: [], route: "", lagMs: 0, voice: [], interrupts: 0, duplex: "" });
  var DUPLEX = { speakers: 1, full: 1 };

  function supported() {
    return !!(AC && window.AudioWorkletNode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket);
  }

  function emit(fn, v) {
    try { if (fn) fn(v); } catch (e) { diag.errors.push(String(e && e.message)); }
  }

  function setState(st) {
    if (!S) return;
    // "speaking" is decided here, from what is really playing.
    S.serverState = st;
    paint();
  }
  function paint() {
    if (!S) return;
    var st;
    if (S.ended) st = "ended";
    else if (S.muted) st = "muted";
    else if (S.flash) st = "interrupted";
    else if (S.serverState === "talking") st = "talking";
    else if (S.playing) st = "speaking";
    else if (S.serverState === "speaking") st = S.anyAsked ? "waiting" : "listening"; // it finished playing
    else st = S.serverState;
    if (st === S.shown) return;
    S.shown = st;
    diag.states.push(st);
    emit(S.o.onState, st);
  }

  function start(o) {
    if (S) return Promise.resolve();
    if (!supported()) return Promise.reject(new Error("This browser cannot hold a live conversation (no AudioWorklet or microphone)."));
    o = o || {};
    diag.calls++;
    S = { o: o, serverState: "connecting", shown: "", muted: false, playing: false, ended: false, flash: 0, anyAsked: false, ws: null, ctx: null, stream: null, cap: null, player: null, src: null, mic: 0, out: 0, lastPos: null,
      duplex: DUPLEX[o.duplex] ? o.duplex : "speakers", route: "", lagMs: 0, t0: performance.now(),
      // Hold-to-talk (the desktop app): the microphone is relayed only while the key is held.
      ptt: o.turn === "ptt", held: false,
      // Hold-to-talk before the call is ready: what is said is kept here and sent once it is (pttFlush).
      live: false, early: null, earlyBytes: 0, pressed: false, released: false,
      // The microphone's frames from the worklet (counted, never kept): is audio really flowing?
      framesIn: 0, framesSent: 0, lastFrameAt: 0, gum: "asking", ring: [],
      det: window.JoyaLiveDetect ? window.JoyaLiveDetect.create() : null };
    var me = S;
    diag.duplex = S.duplex;
    paint();
    return navigator.mediaDevices
      .getUserMedia(MIC_OPTS)
      .then(function (stream) {
        if (me !== S) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new Error("stopped"); }
        me.stream = stream;
        me.gum = "granted";
        watchMic(me);
        me.ctx = new AC({ latencyHint: "interactive" });
        return me.ctx.audioWorklet.addModule(o.worklet || "/static/voice-live-worklet.js");
      })
      .then(function () {
        if (me !== S) throw new Error("stopped");
        var ctx = me.ctx;
        me.src = ctx.createMediaStreamSource(me.stream);
        me.cap = new AudioWorkletNode(ctx, "joya-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
        me.player = new AudioWorkletNode(ctx, "joya-live-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        me.src.connect(me.cap);
        // core E's mouth shapes (spectrum() below): a tap on the reply's audio, nothing else listens to it
        try { me.an = ctx.createAnalyser(); me.an.fftSize = 512; me.player.connect(me.an); me.spec = { bins: new Uint8Array(me.an.frequencyBinCount), hz: ctx.sampleRate / me.an.fftSize }; } catch (e) { me.an = null; }
        me.player.port.onmessage = function (e) { onPlayer(me, e.data || {}); };
        me.cap.port.onmessage = function (e) { onFrame(me, e.data || {}); };
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        return o.direct ? false : loopback(me);
      })
      .then(function (ok) {
        if (me !== S) throw new Error("stopped");
        if (!ok) me.player.connect(me.ctx.destination);
        me.route = diag.route = ok ? "loopback" : "direct";
        return openSocket(me);
      })
      .catch(function (e) {
        if (me === S) fail(e && e.message === "stopped" ? "" : (e && e.name === "NotAllowedError" ? "The microphone was refused." : String((e && e.message) || e)));
        throw e;
      });
  }

  /* ---- the microphone going away: its track ended (unplugged, taken), or the devices changed ---- */

  /*
   * Hold-to-talk, warm between presses: the microphone is closed after
   * MIC_REST_MS without a press (Windows' "microphone in use" mark goes away;
   * nothing is captured), and opened again by the next press. The trade-off:
   * that press waits for the microphone (getUserMedia on a device already
   * allowed: ~0.1-0.4 s), so its first syllable can be clipped; presses within
   * MIC_REST_MS of the last one start at once. Nothing is ever sent between
   * presses either way (onFrame drops what is captured while the key is up).
   */
  var MIC_REST_MS = 10 * 1000;
  function micRest(me) {
    if (me !== S || !me.ptt || me.held || me.resting || !me.stream) return;
    me.resting = true;
    try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
    me.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    me.stream = null;
    me.src = null;
    me.lastFrameAt = 0;
    diag.rests = (diag.rests || 0) + 1;
    note({ k: "mic-rest" });
  }
  function micWake(me) {
    if (!me.resting || me.waking) return;
    me.waking = true;
    note({ k: "mic-wake" });
    navigator.mediaDevices.getUserMedia(MIC_OPTS).then(function (stream) {
      me.waking = false;
      if (me !== S || !me.ctx || !me.cap) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      me.resting = false;
      me.stream = stream;
      me.src = me.ctx.createMediaStreamSource(stream);
      me.src.connect(me.cap);
      watchMic(me);
      note({ k: "mic-awake" });
      if (!me.held) restLater(me);
    }).catch(function () {
      me.waking = false;
      if (me === S) stop("mic");
    });
  }
  function restLater(me) {
    clearTimeout(me.restT);
    var ms = me.o.micRestMs != null ? me.o.micRestMs : MIC_REST_MS;
    if (me.ptt && ms > 0) me.restT = setTimeout(function () { micRest(me); }, ms);
  }

  var MIC_OPTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };
  function micLive(me) {
    var t = me.stream && me.stream.getAudioTracks ? me.stream.getAudioTracks()[0] : null;
    return !!(t && t.readyState === "live");
  }
  function watchMic(me) {
    (me.stream.getAudioTracks ? me.stream.getAudioTracks() : []).forEach(function (t) {
      t.onended = function () { if (me === S) micLost(me, "track-ended"); };
    });
    if (!me.onDev && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      me.onDev = function () { if (me === S && !micLive(me)) micLost(me, "devicechange"); };
      navigator.mediaDevices.addEventListener("devicechange", me.onDev);
    }
  }
  /** The microphone is opened again, once per loss; if that fails the call ends with the reason. */
  function micLost(me, why) {
    if (me.reopening || me.resting) return; // a microphone put to rest (micRest) is not a lost one
    me.reopening = true;
    diag.errors.push("mic: " + why);
    emit(me.o.onEvent, { type: "mic-lost", why: why });
    navigator.mediaDevices.getUserMedia(MIC_OPTS).then(function (stream) {
      me.reopening = false;
      if (me !== S || !me.ctx || !me.cap) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
      if (me.stream) me.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
      me.stream = stream;
      me.src = me.ctx.createMediaStreamSource(stream);
      me.src.connect(me.cap);
      watchMic(me);
      emit(me.o.onEvent, { type: "mic-back", why: why });
    }).catch(function () {
      me.reopening = false;
      if (me === S) stop(why);
    });
  }

  /* ---- echo-cancelled playback: player -> MediaStream -> local WebRTC loopback -> <audio> ---- */

  function noop() {}
  // Opus at a speech-friendly high bitrate, mono, with in-band FEC.
  function opusHi(sdp) {
    var m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp || "");
    if (!m) return sdp;
    var re = new RegExp("a=fmtp:" + m[1] + " ([^\\r\\n]*)");
    return re.test(sdp) ? sdp.replace(re, function (all, p) { return "a=fmtp:" + m[1] + " " + p + ";maxaveragebitrate=96000;stereo=0;usedtx=0"; }) : sdp;
  }
  function loopback(me) {
    if (!window.RTCPeerConnection || !me.ctx.createMediaStreamDestination) return Promise.resolve(false);
    var a, b, el, dest;
    function undo() {
      try { if (a) a.close(); } catch (e) { /* closed */ }
      try { if (b) b.close(); } catch (e) { /* closed */ }
      if (el) { el.srcObject = null; el.remove(); }
      try { if (dest) me.player.disconnect(dest); } catch (e) { /* not connected */ }
      return false;
    }
    try {
      dest = me.ctx.createMediaStreamDestination();
      a = new RTCPeerConnection();
      b = new RTCPeerConnection();
      el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.setAttribute("data-joya-live", "loopback");
      el.hidden = true;
      document.body.appendChild(el);
    } catch (e) {
      return Promise.resolve(undo());
    }
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate).catch(noop); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate).catch(noop); };
    b.ontrack = function (e) { el.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]); };
    me.player.connect(dest);
    dest.stream.getAudioTracks().forEach(function (t) { a.addTrack(t, dest.stream); });
    var connected = new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error("loopback timeout")); }, 3000);
      b.oniceconnectionstatechange = function () {
        var st = b.iceConnectionState;
        if (st === "connected" || st === "completed") { clearTimeout(t); res(); }
        else if (st === "failed") { clearTimeout(t); rej(new Error("loopback failed")); }
      };
    });
    return a.createOffer()
      .then(function (off) { return a.setLocalDescription({ type: "offer", sdp: opusHi(off.sdp) }); })
      .then(function () { return b.setRemoteDescription(a.localDescription); })
      .then(function () { return b.createAnswer(); })
      .then(function (ans) { return b.setLocalDescription({ type: "answer", sdp: opusHi(ans.sdp) }); })
      .then(function () { return a.setRemoteDescription(b.localDescription); })
      .then(function () { return connected; })
      .then(function () {
        me.pcA = a;
        me.pcB = b;
        me.el = el;
        me.dest = dest;
        var p = el.play && el.play();
        if (p && p.catch) p.catch(function (e) { diag.errors.push("loopback play: " + (e && e.name)); });
        me.lagT = setInterval(function () { measureLag(me); }, 1000);
        return true;
      })
      .catch(function (e) {
        diag.errors.push("loopback: " + ((e && e.message) || e));
        return undo();
      });
  }
  /** The loopback's own delay (its jitter buffer), so the played milliseconds stay honest. */
  function measureLag(me) {
    if (!me.pcB || !me.pcB.getStats) return;
    me.pcB.getStats().then(function (rep) {
      rep.forEach(function (r) {
        if (r.type === "inbound-rtp" && r.kind === "audio" && r.jitterBufferEmittedCount) {
          me.lagMs = diag.lagMs = Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) + 20;
        }
      });
    }).catch(noop);
  }
  function heardMs(me, ms) {
    return me.route === "loopback" ? Math.max(0, (ms || 0) - (me.lagMs || 0)) : ms || 0;
  }

  function openSocket(me) {
    var o = me.o;
    var url = o.url || (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/joya-ai/api/live?csrf=" + encodeURIComponent(o.csrf || "") + "&duplex=" + me.duplex + "&route=" + me.route + (o.tab ? "&tab=" + encodeURIComponent(o.tab) : "") + (me.ptt ? "&turn=ptt" : "") +
      (o.resume === "restart" ? "&resume=restart&lang=" + (o.lang === "ar" ? "ar" : "en") : "");
    return new Promise(function (resolve, reject) {
      var ws = (me.ws = new WebSocket(url));
      ws.binaryType = "arraybuffer";
      var opened = false, ready = false;
      var settle = function (err) { if (ready) return; ready = true; if (err) reject(err); else resolve(); };
      ws.onopen = function () { opened = true; };
      ws.onmessage = function (e) {
        if (me !== S) return;
        if (typeof e.data !== "string") return onAudio(me, e.data);
        var m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === "ready") me.callId = m.call || null;
        onMessage(me, m);
        if (m.type === "ready") { me.live = true; note({ k: "ready" }); settle(); pttFlush(me); }
        // Refused, or the server could not open its upstream, before the call was ready: start() fails, with the reason.
        if ((m.type === "error" || m.type === "ended") && !ready) settle(new Error(m.error || m.text || "The live conversation could not start (" + (m.code || m.why || "refused") + ")."));
      };
      ws.onerror = function () { if (!opened) settle(new Error("The live conversation could not connect.")); };
      ws.onclose = function (e) {
        if (me !== S) return;
        if (!ready) settle(new Error(opened ? "The live conversation closed before it was ready (" + (e.code || "closed") + ")." : "The live conversation was refused (" + (e.code || "closed") + ")."));
        end(me.endWhy || "closed", me.endText);
      };
    });
  }

  function onFrame(me, m) {
    if (m.type !== "frame") return;
    if (me.bridging && me.held) { me.bridging = false; note({ k: "own-mic" }); } // its own microphone flows: the feed ends
    me.framesIn++;
    me.lastFrameAt = performance.now();
    me.mic = m.level || 0;
    emit(me.o.onLevel, { mic: me.mic, out: me.out });
    if (me.det && !me.muted) {
      var t = performance.now() - me.t0;
      var v = me.det.mic(me.mic, t);
      if (v) {
        diag.voice.push({ v: v, t: Math.round(t) });
        if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "voice", on: v === "on" }));
      }
    }
    if (me.ptt && !me.held) return; // hold-to-talk: nothing is relayed between turns
    if (me.ptt && !me.live && !me.muted) {
      // The key went down before the call was ready (the first press opens it): keep what is said.
      if (me.earlyBytes < EARLY_MAX) { (me.early = me.early || []).push(m.pcm); me.earlyBytes += m.pcm.byteLength; }
      return;
    }
    if (me.muted || !me.ws || me.ws.readyState !== 1) return;
    me.ws.send(m.pcm);
    me.framesSent++;
    diag.frames++;
    diag.bytesIn += m.pcm.byteLength;
  }

  function onAudio(me, buf) {
    if (buf.byteLength < 6) return;
    var seg = new DataView(buf).getUint32(0, true);
    var pcm = buf.slice(4);
    me.player.port.postMessage({ type: "push", seg: seg, pcm: pcm }, [pcm]);
    me.playing = true;
    paint();
  }

  function onPlayer(me, m) {
    if (m.type === "pos") {
      me.out = m.level || 0;
      emit(me.o.onLevel, { mic: me.mic, out: me.out });
      var was = me.playing;
      me.playing = !!m.playing;
      if (me.det) me.det.out(me.out, me.playing, performance.now() - me.t0);
      if (m.seg && me.ws && me.ws.readyState === 1 && (m.playing || was)) me.ws.send(JSON.stringify({ type: "played", seg: m.seg, ms: heardMs(me, m.ms) }));
      if (me.playing !== was) paint();
      diag.played = m.ms;
    } else if (m.type === "flushed") {
      var f = diag.flushes[diag.flushes.length - 1];
      if (f) { f.flushedAt = performance.now(); f.ms = m.ms; f.seg = m.seg; }
      if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "flushed", seg: m.seg, ms: heardMs(me, m.ms) }));
      me.playing = false;
      paint();
    }
  }

  function onMessage(me, m) {
    emit(me.o.onEvent, m);
    switch (m.type) {
      case "state":
        return setState(m.state);
      case "seg":
        diag.segs++;
        return;
      case "cut":
        me.player.port.postMessage({ type: "drop", seg: m.seg });
        return;
      case "flush":
        // The administrator started talking: drop what is buffered, at once.
        diag.flushes.push({ at: performance.now(), serverAt: m.at });
        silenceTail(me);
        me.player.port.postMessage({ type: "flush", at: m.at });
        me.flash = 1;
        paint();
        clearTimeout(me.flashT);
        me.flashT = setTimeout(function () { me.flash = 0; paint(); }, 700);
        return;
      case "caption":
        diag.captions.push({ who: m.who, text: m.text });
        return emit(me.o.onCaption, { who: m.who, text: m.text, final: m.final !== false });
      case "asked":
        me.anyAsked = true;
        return;
      case "replied":
        me.anyAsked = false;
        return;
      case "stop":
        me.endWhy = "voice-command";
        return;
      case "ended":
        if (me.endWhy !== "restarting") me.endWhy = m.why || "ended";
        me.endText = m.text || me.endText || "";
        return;
      case "restarting":
        me.endWhy = "restarting";
        return;
      case "error":
        diag.errors.push(m.code || "error");
        return;
      case "duplex":
        if (DUPLEX[m.mode]) me.duplex = diag.duplex = m.mode;
        return;
      default:
        return;
    }
  }

  function fail(why) {
    if (!S) return;
    if (why) diag.errors.push(why);
    var o = S.o;
    teardown();
    emit(o.onState, "error");
    emit(o.onEvent, { type: "error", error: why });
  }

  function end(why, text) {
    if (!S) return;
    var o = S.o;
    S.ended = true;
    paint();
    teardown();
    emit(o.onEvent, { type: "ended", why: why, text: text || undefined, local: true });
  }

  function teardown() {
    var me = S;
    S = null;
    if (!me) return;
    clearTimeout(me.flashT);
    clearTimeout(me.muteT);
    clearTimeout(me.relT);
    clearTimeout(me.restT);
    clearInterval(me.lagT);
    try { if (me.ws && me.ws.readyState <= 1) me.ws.close(1000, "hung up"); } catch (e) { /* closed */ }
    try { if (me.pcA) me.pcA.close(); } catch (e) { /* closed */ }
    try { if (me.pcB) me.pcB.close(); } catch (e) { /* closed */ }
    if (me.el) { try { me.el.pause(); } catch (e) { /* gone */ } me.el.srcObject = null; me.el.remove(); }
    if (me.dest) me.dest.stream.getTracks().forEach(function (t) { t.stop(); });
    try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
    try { if (me.cap) me.cap.disconnect(); } catch (e) { /* gone */ }
    try { if (me.player) me.player.disconnect(); } catch (e) { /* gone */ }
    if (me.stream) me.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    if (me.onDev && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener("devicechange", me.onDev);
    if (me.ctx && me.ctx.close) me.ctx.close().catch(function () {});
  }

  var END_WHY = /^(?:button|esc|mic|navigate|unload|track-ended|devicechange|voice-changed|ptt-idle|error:.{0,80})$/;
  /*
   * Is the microphone's audio really flowing? { ok, why } -- why, when not:
   * "asking" (the browser has not answered for the microphone), "refused",
   * "ended" (the device went away), "muted" (by the system or the device),
   * "audio suspended" / "audio closed" (the AudioContext), "no audio" (no
   * frame from the worklet for 600 ms), "muted here" (the call's own mute).
   */
  function micState() {
    var me = S;
    if (!me) return { ok: false, why: "off" };
    if (me.resting) return { ok: false, why: "resting" };
    if (!me.stream) return { ok: false, why: me.gum === "asking" ? "asking" : "refused" };
    var tr = me.stream.getAudioTracks ? me.stream.getAudioTracks()[0] : null;
    if (!tr || tr.readyState !== "live") return { ok: false, why: "ended" };
    if (tr.muted) return { ok: false, why: "muted" };
    if (me.ctx && me.ctx.state !== "running") return { ok: false, why: "audio " + me.ctx.state };
    if (!me.lastFrameAt || performance.now() - me.lastFrameAt > 600) return { ok: false, why: "no audio" };
    if (me.muted) return { ok: false, why: "muted here" };
    return { ok: true, why: "" };
  }
  /*
   * A small ring of what happened to the key and the microphone (counts and
   * times only, never audio or words), sent with the call's end so the server
   * log says why a press was or was not heard: note({k: "down"|"up"|..., at}).
   */
  function note(ev) {
    var me = S;
    if (!me) return;
    var ms = micState();
    var tr = me.stream && me.stream.getAudioTracks ? me.stream.getAudioTracks()[0] : null;
    var e = { k: String(ev.k || "").slice(0, 16), t: Math.round(performance.now() - me.t0), app: typeof ev.at === "number" ? Math.round(ev.at) : undefined, seq: typeof ev.seq === "number" ? ev.seq : undefined,
      in: me.framesIn, sent: me.framesSent, early: me.earlyBytes, ctx: me.ctx ? me.ctx.state : "none", track: tr ? tr.readyState + (tr.muted ? "/muted" : "") : "none", live: me.live, held: me.held, mic: ms.ok ? "ok" : ms.why };
    me.ring.push(e);
    if (me.ring.length > 40) me.ring.shift();
  }
  /** The ring and the totals, for the end message (bounded: the server refuses big frames). */
  function report(me) {
    // At most 20 entries: the server takes JSON messages of up to 4 KB.
    return { ring: me.ring.slice(-20), in: me.framesIn, sent: me.framesSent, early: me.earlyBytes, gum: me.gum, ctx: me.ctx ? me.ctx.state : "none", route: me.route, ms: Math.round(performance.now() - me.t0) };
  }

  function stop(why) {
    if (!S) return;
    var w = END_WHY.test(String(why || "")) ? String(why) : "button";
    note({ k: "end" });
    var rep = report(S);
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "end", why: w, diag: rep })); } catch (e) { /* closed */ }
    // Leaving the page: the socket may not get its message out, the beacon does (the server logs it).
    if ((w === "unload" || w === "navigate") && S.callId && navigator.sendBeacon && S.o.csrf) {
      try { navigator.sendBeacon("/joya-ai/api/live/end", new Blob([JSON.stringify({ _csrf: S.o.csrf, call: S.callId, why: w, diag: rep })], { type: "application/json" })); } catch (e) { /* best effort */ }
    }
    end("hung-up");
  }

  function mute(on) {
    if (!S) return;
    S.muted = !!on;
    if (S.cap) S.cap.port.postMessage({ type: "mute", on: S.muted });
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "mute", on: S.muted })); } catch (e) { /* closed */ }
    paint();
  }

  /** What the loopback still holds (its jitter buffer) is silenced at once, then it plays again. */
  function silenceTail(me) {
    if (!me.el) return;
    me.el.muted = true;
    clearTimeout(me.muteT);
    me.muteT = setTimeout(function () { if (me.el) me.el.muted = false; }, Math.max(150, (me.lagMs || 100) + 120));
  }

  /** Stop the voice now: a tap, Space or Esc (the only way in speakers mode). */
  function interrupt() {
    if (!S || !S.playing) return false;
    diag.interrupts++;
    silenceTail(S);
    S.player.port.postMessage({ type: "flush", at: Date.now() });
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "interrupt" })); } catch (e) { /* closed */ }
    diag.flushes.push({ at: performance.now(), serverAt: 0, by: "tap" });
    return true;
  }

  /*
   * Hold-to-talk: the key went down (the voice, if it speaks, stops at once)
   * and up. The release keeps relaying for PTT_TAIL_MS, so the last syllable
   * the worklet still holds is in the turn, then tells the server to commit.
   */
  var PTT_TAIL_MS = 140;
  // At most this much of what is said before the call is ready is kept (5 s of PCM16 at 24 kHz, look and speak's
  // pre-roll included: sent at once when ready, it stays within the server's 10 s of audio per 5 s).
  var EARLY_MAX = 5 * 48000;
  /*
   * A press may come before the call is ready -- the first press of the key is
   * what opens it, and that takes a second or two. Then the microphone's
   * frames are kept (onFrame) and the press, the frames and, if the key is
   * already up, the release go to the server the moment it is ready. Before
   * 0.1.2 the press was only made at "ready" if the key was still down, and a
   * key released by then gave a call that sat "listening" and heard nothing.
   */
  function pttFlush(me) {
    if (me !== S || !me.ptt || !me.pressed) return;
    var send = function (o) { try { if (me.ws && me.ws.readyState === 1) me.ws.send(o instanceof ArrayBuffer || ArrayBuffer.isView(o) ? o : JSON.stringify(o)); } catch (e) { /* closed */ } };
    send({ type: "ptt", on: true });
    (me.early || []).forEach(function (b) { send(b); diag.frames++; diag.bytesIn += b.byteLength; });
    diag.early = me.earlyBytes;
    me.early = null;
    if (me.released) { me.released = false; send({ type: "ptt", on: false }); }
  }
  /*
   * press(o): o.preroll (look and speak, 2026-10-21) -- PCM16 frames from just before the speech began, held
   * by the camera module's microphone; they go first in the turn. Until this call's own microphone flows (a
   * call just opening, or one whose microphone rests), that microphone keeps feeding the turn: feed(pcm,
   * level), true while it is wanted. So a turn look and speak starts has its first words.
   */
  function press(o) {
    if (!S || !S.ptt) return false;
    clearTimeout(S.relT);
    if (S.held) return true;
    if (S.playing) { silenceTail(S); S.player.port.postMessage({ type: "flush", at: Date.now() }); }
    S.held = true;
    S.released = false;
    clearTimeout(S.restT);
    if (S.resting) micWake(S);
    var pre = o && o.preroll && o.preroll.length ? o.preroll.filter(function (b) { return b && b.byteLength; }) : null;
    // is this call's own microphone flowing now? (not opening, not resting, a frame within the last 200 ms)
    S.bridging = !!(o && o.preroll) && !(S.stream && !S.resting && S.lastFrameAt && performance.now() - S.lastFrameAt < 200);
    if (pre) { diag.preroll = pre.length * 20; note({ k: "preroll" }); }
    if (!S.live) {
      S.pressed = true; // sent when ready (pttFlush)
      if (pre) { S.early = pre.concat(S.early || []); S.earlyBytes += pre.reduce(function (a, b) { return a + b.byteLength; }, 0); }
      return true;
    }
    try {
      if (S.ws && S.ws.readyState === 1) {
        S.ws.send(JSON.stringify({ type: "ptt", on: true }));
        (pre || []).forEach(function (b) { S.ws.send(b); S.framesSent++; diag.frames++; diag.bytesIn += b.byteLength; });
      }
    } catch (e) { /* closed */ }
    return true;
  }
  /** The camera module's microphone feeding a look-and-speak turn until this call's own flows (press). */
  function feed(pcm, level) {
    var me = S;
    if (!me || !me.ptt || !me.held || !me.bridging || me.muted || !pcm || !pcm.byteLength) return false;
    me.mic = level || 0;
    emit(me.o.onLevel, { mic: me.mic, out: me.out });
    if (!me.live) {
      if (me.earlyBytes < EARLY_MAX) { (me.early = me.early || []).push(pcm); me.earlyBytes += pcm.byteLength; }
      return true;
    }
    if (!me.ws || me.ws.readyState !== 1) return true;
    me.ws.send(pcm);
    me.framesSent++;
    diag.frames++;
    diag.bytesIn += pcm.byteLength;
    return true;
  }
  function release() {
    if (!S || !S.ptt || !S.held) return false;
    var me = S;
    clearTimeout(me.relT);
    restLater(me);
    if (!me.live) { me.held = false; me.released = true; return true; } // committed when ready (pttFlush)
    me.relT = setTimeout(function () {
      if (me !== S || !me.held) return;
      me.held = false;
      try { if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "ptt", on: false })); } catch (e) { /* closed */ }
    }, PTT_TAIL_MS);
    return true;
  }

  function duplex(mode) {
    if (!S) return DUPLEX[mode] ? mode : "";
    if (DUPLEX[mode] && mode !== S.duplex) {
      S.duplex = diag.duplex = mode;
      try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "duplex", mode: mode })); } catch (e) { /* closed */ }
    }
    return S.duplex;
  }

  window.VoiceLive = {
    supported: supported,
    start: start,
    stop: stop,
    mute: mute,
    interrupt: interrupt,
    duplex: duplex,
    press: press,
    feed: feed,
    release: release,
    ptt: function () { return !!(S && S.ptt); },
    micState: micState,
    /* Hold-to-talk: is the microphone closed between presses (micRest)? */
    resting: function () { return !!(S && S.resting); },
    note: note,
    /*
     * What the page shows, for the server (2026-10-30): {type: "reply-shown", turn} once a reply of this
     * call is on the screen (the voice may then say "the details are on screen"), and {type: "screen",
     * path, title, panel} -- the Joya page and panel in view, sent with each hand-off to JOYA AI.
     */
    tell: function (m) {
      if (!S || !S.ws || S.ws.readyState !== 1 || !m || (m.type !== "reply-shown" && m.type !== "screen")) return;
      try { S.ws.send(JSON.stringify(m)); } catch (e) { /* closed */ }
    },
    ack: function (nonce, ok, why) {
      if (!S || !S.ws || S.ws.readyState !== 1 || !nonce) return;
      try { S.ws.send(JSON.stringify({ type: "ui-ack", nonce: String(nonce), ok: !!ok, why: why ? String(why).slice(0, 200) : undefined })); } catch (e) { /* closed */ }
    },
    /* The last screen action can still be undone for `ms` (0: no longer), so a spoken "undo" is caught. */
    undoable: function (ms) {
      if (!S || !S.ws || S.ws.readyState !== 1) return;
      try { S.ws.send(JSON.stringify({ type: "ui-undoable", ms: Math.max(0, Math.min(60000, Number(ms) || 0)) })); } catch (e) { /* closed */ }
    },
    speaking: function () { return !!(S && S.playing); },
    /* Eye contact (2026-10-20): the reply playing pauses (on) and goes on from the same place (off); nothing is dropped. */
    pause: function (on) {
      if (!S || !S.player) return false;
      S.paused = !!on;
      S.player.port.postMessage({ type: "hold", on: !!on });
      return true;
    },
    paused: function () { return !!(S && S.paused); },
    /* The reply's spectrum while it plays ({ bins: getByteFrequencyData, hz per bin }), else null: core E shapes its mouth from it. */
    spectrum: function () { if (!S || !S.an || !S.playing) return null; S.an.getByteFrequencyData(S.spec.bins); return S.spec; },
    route: function () { return S ? S.route : ""; },
    muted: function () { return !!(S && S.muted); },
    active: function () { return !!S; },
    callId: function () { return S ? S.callId || null : null; },
    state: function () { return S ? S.shown : "idle"; },
  };
})();
