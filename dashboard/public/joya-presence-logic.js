"use strict";
/*
 * Eye contact (2026-10-20, mockups/eye-contact/DESIGN.md): "a bot that knows you're there" -- the pure part.
 * The laptop camera is used only to sense presence, on the machine; this file turns what the face model saw
 * (in the camera module's worker, joya-presence-worker.js) into the few things the rest of the page may know:
 *
 *   state   "present" | "looking" | "away"   (null: unknown -- the camera is off)
 *   gaze    { x, y } in -1..1, quantised to quarters: where the person is as seen from the bot (the bot's
 *           eyes go there; x > 0 = to the screen's right, y > 0 = lower down)
 *
 * Nothing here touches the camera, the page or the network; the tests (dashboard/tools/test-presence.cjs)
 * feed it synthetic landmark streams.
 *
 *   summarize(result)          FaceLandmarker result -> [{ cx, cy, w, yaw, pitch, jaw, ey, mouth }] (no landmarks kept)
 *   vadFrame(samples, rate)    one microphone frame -> { level, voiced, flat, band, zcr }: is it a voice?
 *   lipMotion(o)               the mouth's movement over the last ~0.7 s -> 0..1 (talking, not a still open mouth / a smile / chewing)
 *   poseOf(matrix)             a facial transformation matrix (4x4, column-major) -> { yaw, pitch } in degrees
 *   aim(face, bot, geo)        where the person's head should point to look at the bot / the screen
 *   gazeFor(face, bot, geo)    the bot's eye direction toward the person (quantised)
 *   createTracker(o)           the presence / attention state machine, with hysteresis
 *   createSpeakGate(o)         "look and speak": a frontal look at the bot + speech onset (+ the mouth moving)
 *   createReplyPause(o)        a reply pauses after ~1.5 s looking away, resumes on looking back
 *   createHolder(o)            toasts and sounds held while away, one summary on return
 *   rate(o)                    frames per second (0 = release the camera)
 *   normPrefs(p)               the switches (all off by default, but "release in energy saver")
 *   pickCamera(devs, choice)   which camera: the stored choice, else Automatic (built-in first, phone / virtual last)
 *   indication(o)              what the page shows (2026-10-21): the pill's word, the ring on the bot, the caption, why
 *                              look and speak waits -- drawn from the module's own state only, never sent
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JoyaPresenceLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  var DEG = 180 / Math.PI;
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function q4(v) { return Math.round(clamp(v, -1, 1) * 4) / 4 || 0; }

  /* ------------------------------------------------------------ timing (ms) and thresholds */
  var T = {
    PRESENT_MS: 400,     // a face seen this long (two frames at 5 fps) -> present
    GAP_MS: 900,         // a face missing for one or two frames does not break a run
    AWAY_MS: 8000,       // no face this long -> away (stepped out, not a glance aside)
    LOOK_ON_MS: 250,     // facing the screen this long -> looking
    LOOK_OFF_MS: 1200,   // not facing it this long -> present (no flicker when glancing at the keyboard)
    BOT_ON_MS: 500,      // facing the bot this long -> attending to it (look and speak may arm)
    BOT_OFF_MS: 300,
    PAUSE_MS: 1500,      // a reply pauses after this long turned away
  };
  // The assumed desk: a 14" laptop screen (34 x 21 cm), the camera centred on its top edge, a 60 degree
  // horizontal field of view at 4:3, a face about 15 cm wide. Good enough for "roughly at the screen" and
  // "roughly at the bot"; the tolerances below absorb the rest (and eyes move without the head).
  var GEO = { screenW: 34, screenH: 21, faceW: 15, tanH: Math.tan(30 / DEG), aspect: 0.75 };
  var TOL = {
    screenYaw: 12, screenUp: 15, screenDown: 10,   // degrees beyond the screen's edges still "at the screen"
    // Around the bot. 2026-10-21 (look and speak never armed on a real laptop): a person looks at a bot 12 deg
    // aside mostly with the EYES -- the head turns maybe a third of it -- and MediaPipe's head pose jitters by a
    // few degrees, so the old 9 / 10 (and 7 for speaking) almost never held for 0.6 s. Now the eyes' up/down
    // (the eyeLookUp / eyeLookDown blendshapes, which have no left/right ambiguity) is added to the head's
    // pitch, the angles are the median of the last three frames, and the tolerances are realistic.
    botYaw: 12, botUp: 13, botDown: 12,
    speakYaw: 10,                                 // look and speak: still a frontal look toward the bot's side
    eyePitch: 25,                                 // degrees of gaze for eyeLookUp / eyeLookDown going 0 -> 1
    frontal: 30,                                  // |yaw| beyond this is not frontal at all
  };

  /* ------------------------------------------------------------ the model's output, reduced */
  /**
   * Yaw and pitch (degrees) of a head from its facial transformation matrix (column-major 4x4, the canonical
   * face looking down +z at the camera). yaw > 0: turned toward the screen's right (the person's right);
   * pitch > 0: looking up.
   */
  function poseOf(m) {
    if (!m || m.length < 16) return null;
    // the face's forward axis is the matrix's third column
    var fx = m[8], fy = m[9], fz = m[10];
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(fz)) return null;
    var yaw = -Math.atan2(fx, fz) * DEG;
    var pitch = Math.atan2(fy, Math.sqrt(fx * fx + fz * fz)) * DEG;
    return { yaw: yaw, pitch: pitch };
  }
  /** A rotation (yaw, pitch in degrees, the same senses) as a column-major matrix: the tests' synthetic heads. */
  function matrixOf(yaw, pitch) {
    var a = -yaw / DEG, b = pitch / DEG;
    // forward = (sin a cos b, sin b, cos a cos b); a full orthonormal frame around it
    var f = [Math.sin(a) * Math.cos(b), Math.sin(b), Math.cos(a) * Math.cos(b)];
    var r = [Math.cos(a), 0, -Math.sin(a)];
    var u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    return [r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, f[0], f[1], f[2], 0, 0, 0, -50, 1];
  }
  function blend(shapes, name) {
    var c = shapes && shapes.categories;
    if (!c) return null;
    for (var i = 0; i < c.length; i++) if (c[i].categoryName === name) return c[i].score;
    return null;
  }
  /**
   * The mouth, as a few numbers (2026-10-22: "lip reading" -- is this person talking?), or null without blendshapes:
   *   lip  the inner lips' gap (landmarks 13 / 14) in nose lengths (168 between the eyes -> 2 under the nose): a size-
   *        and distance-free opening, ~0 with the lips together (null with fewer than 468 landmarks)
   *   mc   mouthClose (lips pressed while the jaw is open: chewing), sm the smile (left / right averaged),
   *   pk   mouthPucker / mouthFunnel (rounded vowels: o, u)
   */
  function mouthOf(pts, bs) {
    var mc = blend(bs, "mouthClose");
    if (mc == null) return null;
    var lip = null;
    if (pts && pts.length >= 468 && pts[13] && pts[14] && pts[168] && pts[2]) {
      var nose = Math.abs(pts[2].y - pts[168].y);
      if (nose > 1e-4) lip = Math.max(0, (pts[14].y - pts[13].y) / nose);
    }
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };
    return { lip: lip == null ? null : r3(lip), mc: r3(mc), sm: r3(((blend(bs, "mouthSmileLeft") || 0) + (blend(bs, "mouthSmileRight") || 0)) / 2),
      pk: r3(Math.max(blend(bs, "mouthPucker") || 0, blend(bs, "mouthFunnel") || 0)) };
  }
  /**
   * A FaceLandmarker result -> one small record per face: its box centre and width (fractions of the frame,
   * the camera's own unmirrored image), its head pose, how open the jaw is. The landmarks stop here.
   */
  function summarize(res) {
    var out = [];
    var L = (res && res.faceLandmarks) || [];
    for (var i = 0; i < L.length; i++) {
      var pts = L[i];
      if (!pts || !pts.length) continue;
      var x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (var j = 0; j < pts.length; j++) {
        var p = pts[j];
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      var mx = res.facialTransformationMatrixes && res.facialTransformationMatrixes[i];
      var pose = poseOf(mx && (mx.data || mx));
      if (!pose) continue;
      var bs = res.faceBlendshapes && res.faceBlendshapes[i];
      var jaw = blend(bs, "jawOpen");
      var up = (blend(bs, "eyeLookUpLeft") || 0) + (blend(bs, "eyeLookUpRight") || 0), dn = (blend(bs, "eyeLookDownLeft") || 0) + (blend(bs, "eyeLookDownRight") || 0);
      var hasEye = blend(bs, "eyeLookDownLeft") != null || blend(bs, "eyeLookUpLeft") != null;
      out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(0.001, x1 - x0), yaw: pose.yaw, pitch: pose.pitch, jaw: jaw == null ? null : jaw, ey: hasEye ? ((up - dn) / 2) * TOL.eyePitch : null,
        mouth: mouthOf(pts, bs) });
    }
    return out;
  }

  /* ------------------------------------------------------------ geometry: where the person is, where they look */
  /** The person's head in the screen plane (cm; x right of the camera, y down from it) and their distance. */
  function where(face, geo) {
    geo = geo || GEO;
    var D = clamp(geo.faceW / (2 * geo.tanH * face.w), 25, 200);
    var x = (0.5 - face.cx) * 2 * geo.tanH * D;             // the camera's image is not mirrored
    var y = (face.cy - 0.5) * 2 * geo.tanH * geo.aspect * D;
    return { x: x, y: y, D: D };
  }
  function bot0(bot) { return { x: clamp(bot && isFinite(bot.x) ? bot.x : 0.85, 0, 1), y: clamp(bot && isFinite(bot.y) ? bot.y : 0.85, 0, 1) }; }
  /**
   * Where the head should point (yaw, pitch) to look at the bot, and the screen's edges in the same terms.
   * bot: the bot's centre as fractions of the screen (x 0 left .. 1 right, y 0 top .. 1 bottom).
   */
  function aim(face, bot, geo) {
    geo = geo || GEO;
    var u = where(face, geo), b = bot0(bot);
    var bx = (b.x - 0.5) * geo.screenW, by = b.y * geo.screenH;
    var yawTo = function (x) { return Math.atan2(x - u.x, u.D) * DEG; };
    var pitchTo = function (y) { return -Math.atan2(y - u.y, u.D) * DEG; };
    return {
      bot: { yaw: yawTo(bx), pitch: pitchTo(by) },
      screen: { yaw0: yawTo(-geo.screenW / 2), yaw1: yawTo(geo.screenW / 2), up: pitchTo(0), down: pitchTo(geo.screenH) },
      at: u,
    };
  }
  /** Is this face turned toward the screen / the bot / frontal enough to speak to it? */
  function classify(face, bot, geo) {
    var a = aim(face, bot, geo), s = a.screen, yw = face.yaw, pt = face.pitch;
    var gp = face.ey != null ? pt + face.ey : pt; // where the eyes point, up / down (the head plus the eyes)
    var frontal = Math.abs(yw) <= TOL.frontal;
    var screen = frontal && yw >= s.yaw0 - TOL.screenYaw && yw <= s.yaw1 + TOL.screenYaw && pt <= s.up + TOL.screenUp && pt >= s.down - TOL.screenDown;
    var dy = yw - a.bot.yaw, dp = gp - a.bot.pitch;
    var atBot = screen && Math.abs(dy) <= TOL.botYaw && dp <= TOL.botUp && dp >= -TOL.botDown;
    var speak = atBot && Math.abs(dy) <= TOL.speakYaw;
    return { screen: screen, bot: atBot, speak: speak, frontal: frontal, dy: dy, dp: dp };
  }
  /** The bot's eyes toward the person (from the bot's place on the screen), in quarters of -1..1. */
  function gazeFor(face, bot, geo) {
    geo = geo || GEO;
    var u = where(face, geo), b = bot0(bot);
    var bx = (b.x - 0.5) * geo.screenW, by = b.y * geo.screenH, k = u.D * 0.55;
    return { x: q4((u.x - bx) / k), y: q4((u.y - by) / k) };
  }

  /** The person at the desk: the biggest face (the nearest), kept while it stays about as big; others counted. */
  function pickPrimary(faces, prev) {
    if (!faces || !faces.length) return { face: null, others: 0 };
    var big = faces[0];
    for (var i = 1; i < faces.length; i++) if (faces[i].w > big.w) big = faces[i];
    var face = big;
    if (prev) {
      var best = null, bd = 1e9;
      faces.forEach(function (f) { var d = Math.hypot(f.cx - prev.cx, f.cy - prev.cy); if (d < bd) { bd = d; best = f; } });
      if (best && bd < 0.2 && best.w >= big.w * 0.7) face = best;
    }
    var others = 0;
    faces.forEach(function (f) { if (f !== face && f.w >= face.w * 0.5) others++; });
    return { face: face, others: others };
  }

  /* ------------------------------------------------------------ the mouth moving: talking, or not (2026-10-22) */
  /**
   * createLipMotion() -> { push(face, t), score(t) -> { score, std, rest, n } | null, reset() }.
   * Talking moves the mouth open and shut 3-8 times a second; a still open mouth, a held smile, chewing with the
   * lips together do not. So: one "opening" number per frame -- the lips' gap, plus the jaw where the lips are not
   * pressed (jawOpen - mouthClose: chewing moves the jaw with the lips closed), plus rounding (pucker / funnel),
   * minus a little of the smile (a smile shows the teeth: the lips part without speech) -- and its spread
   * (standard deviation) over the last LIP_WIN_MS. That spread is compared with this person's own rest jitter (the
   * model's frame-to-frame noise on their face, learnt as it goes: down quickly, up slowly), so a face the model
   * reads noisily needs more movement. Without the lips' landmarks (a stand-in face model) the jaw alone.
   * score: 0 (still) .. 1 (clearly talking); null when no mouth has been seen lately.
   */
  var LIP = { WIN_MS: 700, REST0: 0.01, REST_MIN: 0.004, REST_MAX: 0.05, K: 1.7, SPAN: 0.05, WEAK: 0.25, STRONG: 0.55 };
  function openingOf(f) {
    var m = f && f.mouth, jaw = f && f.jaw;
    if (m && m.lip != null) return m.lip + 0.4 * Math.max(0, (jaw || 0) - (m.mc || 0)) + 0.3 * (m.pk || 0) - 0.12 * (m.sm || 0);
    if (jaw != null) return jaw + 0.3 * ((m && m.pk) || 0);
    return null;
  }
  function createLipMotion() {
    var Q = [], rest = LIP.REST0, last = null;
    function win(t) {
      var gap = Q.length > 1 ? (Q[Q.length - 1][0] - Q[0][0]) / (Q.length - 1) : 200;
      return Math.max(LIP.WIN_MS, 2.6 * gap); // at a slow frame rate, at least the last three frames
    }
    function stat(t) {
      var w = win(t), a = Q.filter(function (e) { return t - e[0] <= w; });
      if (a.length < 3) return null;
      var x = a.map(function (e) { return e[1]; });
      var sd = function (y) { var mu = 0; y.forEach(function (v) { mu += v; }); mu /= y.length; var s2 = 0; y.forEach(function (v) { s2 += (v - mu) * (v - mu); }); return { mu: mu, sd: Math.sqrt(s2 / (y.length - 1)) }; };
      var r = sd(x);
      // a frame or two the model read badly (the lips misplaced) are not the mouth moving: with 5+ frames the spread
      // is the median absolute deviation (scaled to a standard deviation), which a couple of wild frames do not move
      if (x.length >= 5) {
        var med = function (y) { var b = y.slice().sort(function (p, q) { return p - q; }), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; };
        var c = med(x);
        return { std: Math.min(r.sd, Math.max(r.sd * 0.6, 1.4826 * med(x.map(function (v) { return Math.abs(v - c); })))), n: a.length };
      }
      return { std: r.sd, n: a.length };
    }
    return {
      push: function (f, t) {
        var o = openingOf(f);
        if (o == null) return;
        Q.push([t, o]); while (Q.length > 40 || (Q.length && t - Q[0][0] > 3000)) Q.shift();
        var st = stat(t);
        // the rest jitter: a third of the still frames read under it (down 2 %, up 1 % a frame); movement (3x it) is not rest
        if (st && st.n >= 3 && st.std < 3 * rest) rest = clamp(rest * (st.std < rest ? 0.98 : 1.01), LIP.REST_MIN, LIP.REST_MAX);
        last = t;
      },
      score: function (t) {
        if (last == null || t - last > 1500) return null;
        var st = stat(t);
        if (!st) return null; // fewer than three frames: too few to tell
        return { score: Math.round(clamp((st.std - LIP.K * rest) / LIP.SPAN, 0, 1) * 100) / 100, std: st.std, rest: rest, n: st.n };
      },
      reset: function () { Q = []; last = null; },
      rest: function () { return rest; },
      open: function (t) { return last != null && t - last <= 600 && Q.length ? Q[Q.length - 1][1] : null; },
    };
  }

  /* ------------------------------------------------------------ the state machine */
  /**
   * createTracker({ bot, geo }) -> { push(faces, t), setBot(pos), snapshot(), reset() }.
   * push() takes the summaries of one frame (summarize) and the time (ms); it returns the snapshot:
   *   { state, gaze, changed,            -- the public part
   *     atBot, speak, others, mouth, turnedAwayMs, face, facingNow }  -- the module's own (look and speak, a reply's pause)
   */
  function createTracker(o) {
    o = o || {};
    var bot = o.bot || null, geo = o.geo || GEO;
    var S;
    function reset() {
      S = { state: null, lastFace: -1e12, runStart: null, screenSince: null, notScreenSince: null, botSince: null, notBotSince: null, atBot: false, looking: false,
        prev: null, gaze: null, lips: S && S.lips ? (S.lips.reset(), S.lips) : createLipMotion(), lastLook: -1e12, others: 0, speak: false, face: null, poses: [], dy: null, dp: null };
    }
    function med3(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
    /** The face with its angles as the median of the last three frames: one jittery frame changes nothing. */
    function steady(f) {
      S.poses.push([f.yaw, f.pitch, f.ey]); if (S.poses.length > 3) S.poses.shift();
      var e = S.poses.map(function (p) { return p[2]; }).filter(function (v) { return v != null; });
      return Object.assign({}, f, { yaw: med3(S.poses.map(function (p) { return p[0]; })), pitch: med3(S.poses.map(function (p) { return p[1]; })), ey: e.length ? med3(e) : null });
    }
    reset();
    function snap(changed) {
      var t = S.t || 0;
      var lp = S.lips.score(t);
      return { state: S.state, gaze: S.gaze, changed: !!changed, atBot: S.atBot, speak: S.speak && S.atBot, others: S.others, mouth: lp ? lp.score >= LIP.WEAK : null,
        lip: lp ? lp.score : null, open: S.lips.open(t), lipRest: Math.round(S.lips.rest() * 10000) / 10000,
        turnedAwayMs: S.state ? Math.max(0, t - S.lastLook) : 0, face: !!S.face, dy: S.dy, dp: S.dp, facingNow: !!S.facingNow };
    }
    function push(faces, t) {
      S.t = t;
      var pk = pickPrimary(faces, S.prev), f = pk.face, was = S.state;
      S.face = f; S.others = pk.others;
      if (!f && t - S.lastFace > T.GAP_MS) S.poses = [];
      // at the screen: this frame (quick, as before); at the bot / frontal to speak: the median of three frames
      var cl = f ? classify(f, bot, geo) : { screen: false, bot: false, speak: false, dy: null, dp: null };
      if (f) { var cs = classify(steady(f), bot, geo); cl = { screen: cl.screen, bot: cl.screen && cs.bot, speak: cl.screen && cs.speak, dy: cs.dy, dp: cs.dp }; }
      S.dy = cl.dy == null ? null : Math.round(cl.dy * 10) / 10; S.dp = cl.dp == null ? null : Math.round(cl.dp * 10) / 10;
      if (f) {
        if (t - S.lastFace > T.GAP_MS) S.runStart = t;
        S.lastFace = t; S.prev = f;
        S.gaze = gazeFor(f, bot, geo);
        S.lips.push(f, t);
      } else if (t - S.lastFace > T.GAP_MS) { S.runStart = null; S.prev = null; S.gaze = null; S.lips.reset(); }
      // facing the screen / the bot, each with its own hysteresis
      if (cl.screen) { S.notScreenSince = null; if (S.screenSince == null) S.screenSince = t; S.lastLook = t; }
      else { S.screenSince = null; if (S.notScreenSince == null) S.notScreenSince = t; }
      if (cl.bot) { S.notBotSince = null; if (S.botSince == null) S.botSince = t; }
      else { S.botSince = null; if (S.notBotSince == null) S.notBotSince = t; }
      if (!S.atBot && S.botSince != null && t - S.botSince >= T.BOT_ON_MS) S.atBot = true;
      else if (S.atBot && S.notBotSince != null && t - S.notBotSince >= T.BOT_OFF_MS) S.atBot = false;
      S.speak = cl.speak;
      // turned to the bot, frontal, this frame (before atBot's BOT_ON_MS): look and speak opens its microphone
      // already, so speech that starts with the look is in the pre-roll
      S.facingNow = !!(cl.bot && cl.speak);
      if (!S.looking && S.screenSince != null && t - S.screenSince >= T.LOOK_ON_MS) S.looking = true;
      else if (S.looking && S.notScreenSince != null && t - S.notScreenSince >= T.LOOK_OFF_MS) S.looking = false;
      // here at all
      if (S.started == null) S.started = t;
      var here, st;
      if (S.state === "present" || S.state === "looking") here = t - S.lastFace < T.AWAY_MS;
      else here = !!(f && S.runStart != null && t - S.runStart >= T.PRESENT_MS);
      if (here) st = S.looking ? "looking" : "present";
      // unknown at first; away once the camera has watched an empty desk for AWAY_MS
      else if (S.state === null) st = t - S.started >= T.AWAY_MS ? "away" : null;
      else st = "away";
      if (!here) { S.looking = false; S.atBot = false; }
      S.state = st;
      return snap(st !== was);
    }
    return {
      push: push,
      setBot: function (b) { bot = b || null; },
      snapshot: function () { return snap(false); },
      reset: reset,
    };
  }

  /* ------------------------------------------------------------ is it a voice? (2026-10-22) */
  /**
   * vadFrame(samples, sampleRate) -> { level, voiced, flat, band, zcr } for one ~43 ms frame of the microphone
   * (the analyser's time-domain buffer). Pure arithmetic on numbers in memory; nothing is kept.
   *   level   RMS
   *   voiced  0..1, how periodic it is at a voice's pitch (75-400 Hz; normalised autocorrelation): vowels are,
   *           typing's clicks, a fan, breath are not
   *   flat    0..1, spectral flatness over 150-4000 Hz: noise and clicks are flat (~0.5+), a voice's harmonics are not
   *   band    the share of the energy in 100-4000 Hz (speech's band)
   *   zcr     zero crossings per sample (at ~12 kHz)
   * The signal is first brought to ~12 kHz by averaging (enough for 4 kHz, and cheap: ~0.1 ms a frame).
   */
  var FFTN = 512, HANN = null, TW = null;
  function fftPow(re, im) { // in place, radix 2, n = FFTN; returns the power spectrum's first half
    var n = re.length, i, j, k, len;
    for (i = 1, j = 0; i < n; i++) { var bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; } }
    for (len = 2; len <= n; len <<= 1) {
      var step = n / len, half = len >> 1;
      for (i = 0; i < n; i += len) for (k = 0; k < half; k++) {
        var c = TW[0][k * step], s = TW[1][k * step], a = i + k, b = a + half;
        var xr = re[b] * c - im[b] * s, xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
    var p = new Float64Array(n / 2);
    for (i = 0; i < n / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    return p;
  }
  function vadFrame(x, sr) {
    var n = x ? x.length : 0, i, l;
    if (!n || !(sr > 0)) return { level: 0, voiced: 0, flat: 1, band: 0, zcr: 0 };
    var e = 0;
    for (i = 0; i < n; i++) e += x[i] * x[i];
    var level = Math.sqrt(e / n);
    if (level < 1e-5) return { level: level, voiced: 0, flat: 1, band: 0, zcr: 0 };
    var k = Math.max(1, Math.round(sr / 12000)), fs = sr / k, m = Math.floor(n / k);
    var y = new Float64Array(m), mean = 0;
    for (i = 0; i < m; i++) { var s0 = 0; for (var q = 0; q < k; q++) s0 += x[i * k + q]; y[i] = s0 / k; mean += y[i]; }
    mean /= m;
    var zc = 0;
    for (i = 0; i < m; i++) { y[i] -= mean; if (i && (y[i] >= 0) !== (y[i - 1] >= 0)) zc++; }
    // periodicity at a voice's pitch
    var l0 = Math.max(2, Math.floor(fs / 400)), l1 = Math.min(m - 8, Math.ceil(fs / 75)), voiced = 0;
    var cum = new Float64Array(m + 1);
    for (i = 0; i < m; i++) cum[i + 1] = cum[i] + y[i] * y[i];
    for (l = l0; l <= l1; l++) {
      var r = 0, N = m - l;
      for (i = 0; i < N; i++) r += y[i] * y[i + l];
      var d = Math.sqrt(cum[N] * (cum[m] - cum[l]));
      if (d > 0 && r / d > voiced) voiced = r / d;
    }
    // the spectrum (Hann window, the last FFTN samples, zero-padded when shorter)
    if (!HANN) {
      HANN = new Float64Array(FFTN); TW = [new Float64Array(FFTN / 2), new Float64Array(FFTN / 2)];
      for (i = 0; i < FFTN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFTN - 1));
      for (i = 0; i < FFTN / 2; i++) { TW[0][i] = Math.cos((-2 * Math.PI * i) / FFTN); TW[1][i] = Math.sin((-2 * Math.PI * i) / FFTN); }
    }
    var re = new Float64Array(FFTN), im = new Float64Array(FFTN), off = Math.max(0, m - FFTN), cnt = Math.min(m, FFTN);
    for (i = 0; i < cnt; i++) re[i] = y[off + i] * HANN[Math.floor((i * (FFTN - 1)) / Math.max(1, cnt - 1))];
    var p = fftPow(re, im), hz = fs / FFTN, tot = 0, inb = 0, lg = 0, ar = 0, nb = 0;
    for (i = 1; i < p.length; i++) {
      var f = i * hz;
      if (f < 60) continue;
      tot += p[i];
      if (f >= 100 && f <= 4000) inb += p[i];
      if (f >= 150 && f <= 4000) { lg += Math.log(p[i] + 1e-12); ar += p[i]; nb++; }
    }
    var flat = nb && ar > 0 ? Math.exp(lg / nb) / (ar / nb) : 1;
    return { level: level, voiced: clamp(voiced, 0, 1), flat: clamp(flat, 0, 1), band: tot > 0 ? inb / tot : 0, zcr: zc / m };
  }

  /* ------------------------------------------------------------ look and speak */
  /** How much a microphone frame sounds like a voice, 0..1, from vadFrame's numbers (not its loudness). */
  function speechiness(f) {
    if (!f) return 0;
    var v = clamp((f.voiced - 0.4) / 0.35, 0, 1), fl = clamp((0.3 - f.flat) / 0.22, 0, 1), b = clamp(f.band / 0.7, 0, 1);
    return Math.round(v * fl * b * 100) / 100;
  }
  /**
   * createSpeakGate() -> { vision(snapshot, t), audio(frame, t, busy) -> "start" | null, ended(t), armed(), onset(), status(t) }.
   * It starts listening only when the person has faced the bot (frontal, within TOL.speakYaw) for ARM_MS, nobody
   * else is in view, nothing else is going on (busy: a call held, the voice speaking), COOL_MS have passed since the
   * last turn -- and THEY are speaking (2026-10-22: lips and voice fused):
   *   - a voice (vadFrame: periodic at a voice's pitch, harmonic, in speech's band, over the room's floor) for
   *     ONSET_MS, mostly sound (65 % of the frames since it began: typing is clicks, half silence), AND their lips
   *     moving (lipMotion >= LIP.WEAK) within FUSE_MS of it -- either may come first;
   *   - or a soft voice (voiced, just over the floor) for ONSET_MS while their lips clearly move (>= LIP.STRONG);
   *   - never a voice alone while their mouth is in view and still (the TV, someone off camera); with no mouth in
   *     view (the model gives no blendshapes) a clear voice alone, as before.
   * audio() also takes a plain level (a number: the old meter; the tests' synthetic levels): then any sound over
   * MIN and 4x the floor counts as a voice.
   * A frame or two off the look (GRACE_MS) does not restart the hold.
   */
  function createSpeakGate(o) {
    o = o || {};
    // GRACE_MS (2026-10-21): one or two frames off (a blink, the model's jitter) no longer restart the 0.6 s.
    // DIP_MS (2026-10-21): speech dips between sounds for a few tens of ms; a dip that short does not restart the onset.
    var ARM_MS = o.armMs || 600, ONSET_MS = o.onsetMs || 120, COOL_MS = o.coolMs || 3000, MIN = o.min || 0.02, GRACE_MS = o.graceMs == null ? 450 : o.graceMs, DIP_MS = o.dipMs == null ? 120 : o.dipMs;
    // a voice (vadFrame): its level over the floor (and an absolute minimum, so a silent room's hiss never counts)
    var V_STRONG = 0.5, V_WEAK = 0.3, STRONG_X = 2.5, WEAK_X = 1.6, STRONG_MIN = 0.006, WEAK_MIN = 0.003, FUSE_MS = o.fuseMs || 300, SHARE = 0.65;
    // SPELL_GAP_MS: sounds less than this apart are one spell of talking; onset() is where the spell began (a person
    // who talks as they look arms the gate mid-sentence: the pre-roll reaches back to the sentence's start).
    var SPELL_GAP_MS = 700;
    // FRESH_MS: lips and sound that began within this of each other are one thing starting (the person talking).
    // Otherwise -- a voice going on before their lips moved (a TV), or lips moving long before (chewing) -- the two
    // must move TOGETHER: the mouth's opening and the sound's loudness correlated over SYNC_MS (>= SYNC_MIN).
    // SYNC_HOLD_MS: ...and for this long in a row (one lucky window of a chewing mouth over a TV is not enough).
    var FRESH_MS = 600, JUMP_MS = 300, REST_MS = 400, SYNC_MS = o.syncMs || 1600, SYNC_MIN = o.syncMin || 0.5, SYNC_HOLD_MS = o.syncHoldMs == null ? 450 : o.syncHoldMs, SYNC_LAGS = o.syncLags || [50, 150];
    var G = { since: null, badSince: null, ok: false, mouth: null, lip: null, lipAt: -1e12, lipWAt: -1e12, lipSAt: -1e12, lipRun: null, runN: 0, fromRest: false, stillFrom: null, gap: 200, floor: 0.004,
      st: null, wk: null, loudAt: -1e12, spell: null, onsetAt: null, last: -1e12, level: 0, vad: 0, sp: 0, voiced: null, fused: 0, sync: null, syncSince: null, ov: [], ae: [], slow: null, jumps: [], t: 0, v: null, busy: false, legacy: true };
    function vision(s, t) {
      var good = !!(s && s.state === "looking" && s.atBot && s.speak && !s.others);
      if (good) { G.badSince = null; if (G.since == null) G.since = t; }
      else if (G.since != null) { if (G.badSince == null) G.badSince = t; if (t - G.badSince > GRACE_MS || !s || s.others || s.state !== "looking") { G.since = null; G.badSince = null; } }
      G.ok = G.since != null && G.badSince == null && t - G.since >= ARM_MS;
      G.mouth = s ? s.mouth : null;
      // the lips: a score (lipMotion), or just "moving" (a snapshot without one)
      var lip = !s ? null : s.lip != null ? s.lip : s.mouth === true ? 1 : s.mouth === false ? 0 : null;
      if (G.vt != null) G.gap = clamp(t - G.vt, 30, 600);
      G.vt = t;
      if (lip != null) {
        // a run of the lips moving, and whether it began from a still mouth (REST_MS of it): talking starts from rest;
        // chewing, a mouth that was already going, did not
        if (lip >= LIP.WEAK) { if (t - G.lipWAt > 400) { G.lipRun = t; G.runN = 0; G.fromRest = G.stillFrom != null && t - G.stillFrom >= REST_MS; } G.runN++; G.lipWAt = t; G.stillFrom = null; }
        else if (G.stillFrom == null) G.stillFrom = t;
        if (lip >= LIP.STRONG) G.lipSAt = t;
        G.lipAt = t;
      }
      G.lip = lip;
      if (s && s.open != null) { G.ov.push([t, s.open]); while (G.ov.length && t - G.ov[0][0] > SYNC_MS + 400) G.ov.shift(); }
      G.v = s || null; G.t = t;
    }
    /**
     * Do the mouth and the sound move together? The Pearson correlation of the mouth's opening (each frame) with the
     * sound's log level at that moment (lips lead the voice by ~0.1 s; the frame's time is when its result came:
     * the best of a few lags), over the last SYNC_MS. null with fewer than 5 frames.
     */
    function avSync(t) {
      var vs = G.ov.filter(function (e) { return t - e[0] <= SYNC_MS; });
      if (vs.length < 5 || G.ae.length < 5) return null;
      var best = -1;
      SYNC_LAGS.forEach(function (lag) {
        var xs = [], ys = [];
        vs.forEach(function (e) {
          var at = e[0] + lag, k = -1, d = 1e9;
          for (var i = 0; i < G.ae.length; i++) { var dd = Math.abs(G.ae[i][0] - at); if (dd < d) { d = dd; k = i; } }
          if (k >= 0 && d <= 60) { xs.push(e[1]); ys.push(G.ae[k][1]); }
        });
        if (xs.length < 5) return;
        var mx = 0, my = 0; xs.forEach(function (v, i) { mx += v; my += ys[i]; }); mx /= xs.length; my /= ys.length;
        var sxy = 0, sxx = 0, syy = 0; xs.forEach(function (v, i) { sxy += (v - mx) * (ys[i] - my); sxx += (v - mx) * (v - mx); syy += (ys[i] - my) * (ys[i] - my); });
        var r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
        if (r > best) best = r;
      });
      return best < -0.5 ? null : Math.round(best * 100) / 100;
    }
    /** One spell of sound: since when, how much of it was sound; a dip under DIP_MS keeps it going. */
    function spell(sp, on, t) {
      if (on) { if (!sp) sp = { since: t, at: t, n: 0, on: 0 }; sp.at = t; }
      else if (sp && t - sp.at > DIP_MS) sp = null;
      if (sp) { sp.n++; if (on) sp.on++; }
      return sp;
    }
    function audio(x, t, busy) {
      var f = typeof x === "number" || x == null ? null : x;
      var level = f ? +f.level || 0 : +x || 0;
      G.legacy = !f;
      G.level = level; G.t = t; G.busy = !!busy;
      G.ae.push([t, Math.log(level + 1e-4)]); while (G.ae.length && t - G.ae[0][0] > SYNC_MS + 800) G.ae.shift();
      var sp = f ? speechiness(f) : 1;
      G.sp = sp; G.voiced = f ? Math.round(f.voiced * 100) / 100 : null;
      // a voice jumping in: 6 dB over the last second's level (the person starts talking over a TV that was on)
      var lg = Math.log(level + 1e-4);
      if (G.slow == null) G.slow = lg;
      if (sp >= V_WEAK && lg - G.slow > 0.7 && (!G.jumps.length || t - G.jumps[G.jumps.length - 1] > 300)) { G.jumps.push(t); if (G.jumps.length > 8) G.jumps.shift(); }
      G.slow += (lg - G.slow) * 0.05;
      // the room's floor: down quickly to a quieter room, up slowly (~5 s) to a steady sound (a fan, music, a TV),
      // so a steady sound is never "speech starting" while a voice's onset still is; a voice does not raise it
      if (level < G.floor) G.floor = Math.max(0.001, G.floor * 0.9 + level * 0.1);
      else if (!f || sp < V_WEAK) G.floor = G.floor + (level - G.floor) * 0.01;
      var strong, weak;
      if (!f) { strong = level > Math.max(MIN, G.floor * 4); weak = strong; }
      else {
        strong = sp >= V_STRONG && level > Math.max(STRONG_MIN, G.floor * STRONG_X);
        weak = strong || (sp >= V_WEAK && level > Math.max(WEAK_MIN, G.floor * WEAK_X));
      }
      G.vad = f ? Math.round(sp * clamp((level / Math.max(G.floor, 0.001) - 1) / (STRONG_X - 1), 0, 1) * 100) / 100 : strong ? 1 : 0;
      G.st = spell(G.st, strong, t);
      G.wk = spell(G.wk, weak, t);
      if (weak) { if (G.spell == null || t - G.loudAt > SPELL_GAP_MS) G.spell = t; G.loudAt = t; }
      var onset = f ? ONSET_MS : Math.max(ONSET_MS, 160);
      var aStrong = !!(G.st && strong && t - G.st.since >= onset && G.st.on >= SHARE * G.st.n);
      var aWeak = !!(G.wk && weak && t - G.wk.since >= onset && G.wk.on >= SHARE * G.wk.n);
      // the lips: in view lately? moving within FUSE_MS (more at a slow frame rate: the next frame is that far off)?
      var fuse = Math.max(FUSE_MS, G.gap + 100);
      var seen = t - G.lipAt <= 1500 && G.mouth != null;
      var lipW = t - G.lipWAt <= fuse, lipS = t - G.lipSAt <= fuse;
      // fresh: the lips began from rest, and the sound began (or jumped up) with them
      // (a jump: within JUMP_MS -- a TV's syllables jump all the time); the lips moving two frames running (one
      // frame the model misread is not a start)
      var near = function (w) { return function (x) { return x != null && x >= G.lipRun - w && x <= G.lipRun + w; }; };
      var fresh = !G.ov.length || G.lipRun == null || G.spell == null || (G.fromRest && (near(FRESH_MS)(G.spell) || (G.runN >= 2 && G.jumps.some(near(JUMP_MS)))));
      G.sync = fresh ? null : avSync(t);
      if (G.sync != null && G.sync >= SYNC_MIN) { if (G.syncSince == null) G.syncSince = t; } else G.syncSince = null;
      var synced = G.syncSince != null && t - G.syncSince >= SYNC_HOLD_MS;
      G.fused = seen ? ((aStrong && lipW) || (aWeak && lipS)) && (fresh || synced) : aStrong;
      if (busy || !G.ok || t - G.last < COOL_MS || !G.fused) return null;
      G.last = t;
      // where the speech began: the spell of sound, but not before the lips began to move (a TV talking all along)
      G.onsetAt = seen && G.lipRun != null ? Math.max(G.spell == null ? t : G.spell, G.lipRun - FUSE_MS) : G.spell;
      G.st = null; G.wk = null;
      return "start";
    }
    return {
      vision: vision, audio: audio,
      ended: function (t) { G.last = t; },
      armed: function () { return G.ok; },
      /** When the spell of talking that started the last turn began (the pre-roll reaches back to it). */
      onset: function () { return G.onsetAt; },
      /** "Show what it sees": each condition, numbers only. */
      status: function (t) {
        t = t == null ? G.t : t;
        var v = G.v || {};
        var need = G.legacy ? Math.max(MIN, G.floor * 4) : Math.max(STRONG_MIN, G.floor * STRONG_X);
        return {
          face: !!v.face, others: v.others || 0, looking: v.state === "looking",
          facing: !!(v.atBot && v.speak), dy: v.dy == null ? null : v.dy, dp: v.dp == null ? null : v.dp, held: G.since != null ? Math.round(t - G.since) : 0, armMs: ARM_MS, armed: G.ok,
          mouth: G.mouth, lip: G.lip, lipNeed: LIP.WEAK, lipRest: v.lipRest == null ? null : v.lipRest, sync: G.sync, syncNeed: SYNC_MIN,
          level: Math.round(G.level * 1000) / 1000, need: Math.round(need * 1000) / 1000, vad: G.vad, voiced: G.voiced, speechy: G.sp,
          loud: !!(G.wk && t - G.wk.at <= DIP_MS), fused: !!G.fused, busy: G.busy, coolLeft: Math.max(0, Math.round(COOL_MS - (t - G.last))),
        };
      },
      _g: G,
    };
  }

  /* ------------------------------------------------------------ a reply pauses while you look away */
  /** createReplyPause({ ms }) -> feed(turnedAwayMs, looking, speaking) -> "pause" | "resume" | null. */
  function createReplyPause(o) {
    var ms = (o && o.ms) || T.PAUSE_MS, paused = false;
    return {
      feed: function (awayMs, looking, speaking) {
        if (!paused && speaking && !looking && awayMs >= ms) { paused = true; return "pause"; }
        if (paused && (looking || !speaking)) { paused = false; return "resume"; }
        return null;
      },
      paused: function () { return paused; },
      reset: function () { var was = paused; paused = false; return was ? "resume" : null; },
    };
  }

  /* ------------------------------------------------------------ held while away */
  var SOUND_RANK = { needs: 7, approval: 6, error: 5, job: 4, done: 3, think: 2, wake: 1 };
  /**
   * createHolder({ max }) -> { setState(state) -> summary | null, offer(kind, item) -> held?, held() }.
   * While the state is "away", toasts ("toast": text), the app's Windows toasts ("native": {title, body})
   * and sounds ("sound": name) are held; when the person is back, setState returns ONE summary:
   *   { count, text, lines, sound }  (sound: the most important one held, played once)
   * The camera off (state null) never holds anything.
   */
  function createHolder(o) {
    var max = (o && o.max) || 50, away = false, Q = [];
    function summary() {
      if (!Q.length) return null;
      var toasts = Q.filter(function (x) { return x.kind === "toast" || x.kind === "native"; });
      var lines = [];
      toasts.forEach(function (x) {
        var s = x.kind === "native" ? [x.item && x.item.title, x.item && x.item.body].filter(Boolean).join(": ") : String(x.item || "");
        s = s.replace(/\s+/g, " ").trim();
        if (s && lines.indexOf(s) < 0) lines.push(s);
      });
      var snd = null;
      Q.forEach(function (x) { if (x.kind === "sound" && (!snd || (SOUND_RANK[x.item] || 0) > (SOUND_RANK[snd] || 0))) snd = x.item; });
      var n = lines.length;
      var text = n ? "While you were away: " + lines[0] + (n > 1 ? " — and " + (n - 1) + " more" : "") : "";
      return { count: Q.length, notes: n, text: text, lines: lines.slice(0, 5), sound: snd };
    }
    return {
      setState: function (st) {
        var nowAway = st === "away";
        if (nowAway === away) return null;
        away = nowAway;
        if (away) return null;
        var s = summary(); Q = [];
        return s;
      },
      offer: function (kind, item) {
        if (!away) return false;
        if (Q.length < max) Q.push({ kind: kind, item: item });
        return true;
      },
      held: function () { return Q.length; },
      away: function () { return away; },
    };
  }

  /* ------------------------------------------------------------ the camera's frame rate, or none */
  /**
   * rate({ on, hidden, locked, meeting, saver, releaseOnSaver, battery, state, facing }) -> { fps, why }.
   * fps 0: release the camera (why says which rule). 5 fps normally; 2 on battery, in energy saver (if the
   * camera is kept then) or while nobody is there (enough to see them come back); 12 (8 on battery) while they face
   * the bot with look and speak on (facing), so the lips are seen moving.
   */
  function rate(o) {
    o = o || {};
    if (!o.on) return { fps: 0, why: "off" };
    if (o.hidden) return { fps: 0, why: "hidden" };
    if (o.locked) return { fps: 0, why: "locked" };
    if (o.meeting) return { fps: 0, why: "meeting" };
    if (o.saver && o.releaseOnSaver) return { fps: 0, why: "energy saver" };
    // facing the bot with look and speak on (2026-10-22): the lips move 3-8 times a second -- 5 frames a second
    // (2 on battery) cannot see it, so faster while the look lasts (o.facing), and back down as it ends
    if (o.facing) return o.battery || o.saver ? { fps: 8, why: "facing (battery)" } : { fps: 12, why: "facing" };
    if (o.battery || o.saver) return { fps: 2, why: "battery" };
    if (o.state === "away") return { fps: 2, why: "away" };
    return { fps: 5, why: "" };
  }

  /** The switches: { cam, speak, saver } -- off, off, and "release the camera in energy saver" on. */
  function normPrefs(p) {
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = null; } }
    p = p && typeof p === "object" ? p : {};
    return { cam: p.cam === true, speak: p.cam === true && p.speak === true, saver: p.saver !== false };
  }

  /* ------------------------------------------------------------ which camera (2026-10-21)
   * Windows' default camera is often not the laptop's own: Phone Link / "Connected Camera" puts the phone first,
   * and OBS / NVIDIA Broadcast / DroidCam... add virtual ones. The choice is this browser's / app's own
   * (localStorage "joya-presence-camera" = { id, label }; ids can change, so the label is the fallback) and is
   * never sent anywhere. "Automatic" (no choice): a built-in RGB camera, else another real one, else an IR
   * camera (Windows Hello's; useless for the face model unless it is all there is), else a phone / virtual one,
   * else the browser's default.
   */
  var CAM_VIRTUAL = /phone|\blink\b|connected camera|windows virtual|virtual|\bobs\b|nvidia broadcast|\bsnap\b|droidcam|iriun|\bcamo\b|epoccam|continuity/i;
  var CAM_IR = /\bIR\b|infra-?red/; // "Integrated IR Camera" (case matters: "Iriun", "firmware")
  var CAM_BUILTIN = /integrated|built-?in|internal|hd webcam|hd camera|hd user facing|facetime|\bfront\b|uvc|user facing/i;
  /** A label without the USB ids Windows appends ("Integrated Webcam (0c45:6a1d)" -> "Integrated Webcam"). */
  function camLabel(l) { return String(l || "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").replace(/\s+/g, " ").trim(); }
  /** "virtual" | "ir" | "builtin" | "other" ("" for a camera whose label is not known yet). */
  function cameraKind(label) {
    var l = camLabel(label);
    if (!l) return "";
    if (CAM_VIRTUAL.test(l)) return "virtual";
    if (CAM_IR.test(l)) return "ir";
    if (CAM_BUILTIN.test(l)) return "builtin";
    return "other";
  }
  /** The short name for the pill ("Camera on · Integrated Webcam"). */
  function shortCam(label, max) {
    var l = camLabel(label).replace(/^(?:\d+\s*-\s*)/, ""); // "1 - Integrated Camera" (some drivers)
    max = max || 26;
    return l.length > max ? l.slice(0, max - 1).replace(/\s+$/, "") + "…" : l;
  }
  /** The stored choice: { id, label } or null (Automatic). */
  function normCamChoice(v) {
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { v = null; } }
    if (!v || typeof v !== "object") return null;
    var id = typeof v.id === "string" ? v.id.slice(0, 256) : "", label = typeof v.label === "string" ? v.label.slice(0, 200) : "";
    return id || label ? { id: id, label: label } : null;
  }
  /** The video inputs (MediaDeviceInfo-like), in Automatic's order of preference (stable within a kind). */
  function rankCameras(devs) {
    var R = { builtin: 0, other: 1, ir: 2, virtual: 3, "": 4 };
    return (devs || []).filter(function (d) { return d && d.kind === "videoinput"; })
      .map(function (d, i) { return { d: d, i: i, r: R[cameraKind(d.label)] }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.d; });
  }
  /**
   * Which camera to open: { id, label, how, note }. id null = no deviceId constraint (the browser's default:
   * nothing better known -- before the camera was ever allowed the labels and ids are hidden).
   *   how  "chosen" (the stored id) | "chosen-label" (the same camera under a new id) | "auto" | "default"
   *   note why the choice was not followed (the chosen camera is gone or failed), else ""
   * o.avoid: ids that failed to open this time.
   */
  function pickCamera(devs, choice, o) {
    var avoid = (o && o.avoid) || [];
    var vids = (devs || []).filter(function (d) { return d && d.kind === "videoinput" && d.deviceId && avoid.indexOf(d.deviceId) < 0; });
    choice = normCamChoice(choice);
    var note = "";
    if (choice) {
      var byId = choice.id && vids.filter(function (d) { return d.deviceId === choice.id; })[0];
      if (byId) return { id: byId.deviceId, label: byId.label || choice.label, how: "chosen", note: "" };
      var cl = camLabel(choice.label).toLowerCase();
      var byLabel = cl && vids.filter(function (d) { return camLabel(d.label).toLowerCase() === cl; })[0];
      if (byLabel) return { id: byLabel.deviceId, label: byLabel.label, how: "chosen-label", note: "" };
      var gone = shortCam(choice.label, 40) || "The camera you chose";
      note = (choice.id && avoid.indexOf(choice.id) >= 0 ? gone + " could not be opened" : gone + " is not connected") + " — using Automatic";
    }
    var known = vids.filter(function (d) { return camLabel(d.label); });
    var best = rankCameras(known)[0];
    if (best) return { id: best.deviceId, label: best.label, how: "auto", note: note };
    return { id: null, label: "", how: "default", note: note };
  }

  /* ------------------------------------------------------------ what the page shows (2026-10-21) */
  // The words, in one place (the pill, the caption under the bot, the hint on the pill).
  var LOOK_TEXT = { watching: "Watching", here: "You're here", me: "Looking at me" };
  var CAPTION_TEXT = { listening: "Listening — you looked and spoke", paused: "Paused — look back to continue" };
  var BLOCK_TEXT = { voice: "voice is off", others: "someone else is in view", busy: "a turn or a reply is on", cool: "a moment — it just answered" };
  /**
   * indication({ camera, state, atBot, speakOn, voice, busy, others, coolLeft, held, armMs, armed, paused, listening })
   *   -> null (camera off) | { look, ring, arm, armLeft, caption, blocked, word }
   *   look     "watching" (nobody, or away) | "here" (present / at the screen) | "me" (looking at the bot itself)
   *   ring     the ring on the bot: "noticed" (you look at it) | "arming" (look and speak: the 0.6 s hold filling,
   *            arm 0..1, armLeft ms to go) | "ready" (held: it listens for your voice) | null
   *   caption  "listening" (a turn look and speak started) | "paused" (a reply paused: you looked away) | null
   *   blocked  look and speak is on but cannot start now: "voice" | "others" | "busy" | "cool" | null
   *   word     the pill's state word
   * Pure: the module calls it with its own numbers; nothing of it leaves the page.
   */
  function indication(o) {
    if (!o || !o.camera) return null;
    var st = o.state;
    var look = st === "looking" && o.atBot ? "me" : st === "present" || st === "looking" ? "here" : "watching";
    var listening = !!o.listening, paused = !!o.paused && !listening;
    var blocked = null;
    if (o.speakOn && !listening) {
      if (o.voice === false) blocked = "voice";
      else if (o.others) blocked = "others";
      else if (o.busy) blocked = "busy";
      else if (o.coolLeft > 0) blocked = "cool";
    }
    var armMs = o.armMs > 0 ? o.armMs : 600, held = Math.max(0, +o.held || 0);
    var ring = null, arm = 0, armLeft = 0;
    if (!listening && !paused) {
      if (o.speakOn && !blocked && look === "me" && (held > 0 || o.armed)) {
        arm = o.armed ? 1 : clamp(held / armMs, 0, 1);
        armLeft = o.armed ? 0 : Math.max(0, Math.round(armMs - held));
        ring = o.armed ? "ready" : "arming";
      } else if (look === "me") ring = "noticed";
    }
    var caption = listening ? "listening" : paused ? "paused" : null;
    var word = listening ? "Listening" : paused ? "Paused" : LOOK_TEXT[look];
    return { look: look, ring: ring, arm: Math.round(arm * 100) / 100, armLeft: armLeft, caption: caption, blocked: blocked, word: word };
  }
  /** The hint on the pill (hover / tap): what look and speak is doing, or why it waits. Never more than a line. */
  function speakHint(ind, speakOn) {
    if (!speakOn) return "Look and speak is off";
    if (!ind) return "";
    if (ind.caption === "listening") return "Look and speak: listening";
    if (ind.blocked) return "Look and speak waits: " + BLOCK_TEXT[ind.blocked];
    if (ind.ring === "arming" || ind.ring === "ready") return "Look and speak: keep looking and talk";
    return "Look and speak: look at me and talk";
  }

  return {
    T: T, GEO: GEO, TOL: TOL, SOUND_RANK: SOUND_RANK,
    poseOf: poseOf, matrixOf: matrixOf, summarize: summarize, where: where, aim: aim, classify: classify, gazeFor: gazeFor, pickPrimary: pickPrimary,
    vadFrame: vadFrame, speechiness: speechiness, createLipMotion: createLipMotion, LIP: LIP, createTracker: createTracker, createSpeakGate: createSpeakGate, createReplyPause: createReplyPause, createHolder: createHolder,
    rate: rate, normPrefs: normPrefs,
    camLabel: camLabel, cameraKind: cameraKind, shortCam: shortCam, normCamChoice: normCamChoice, rankCameras: rankCameras, pickCamera: pickCamera,
    indication: indication, speakHint: speakHint, LOOK_TEXT: LOOK_TEXT, CAPTION_TEXT: CAPTION_TEXT, BLOCK_TEXT: BLOCK_TEXT,
  };
});
