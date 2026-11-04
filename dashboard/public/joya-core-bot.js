"use strict";
/*
 * JOYA AI core E, "Bot" (approved 2026-10-19, mockups/emo-core-states): a faint
 * wireframe head -- a cube grid projected onto a rounded box (superellipsoid
 * |x|^p + |y|^p + |z|^p = 1, even grid on the front so the face keeps its
 * face), grid nodes as small dots, one of ten accessories -- with a FACE in ONE
 * state colour and a soft glow of that colour (and in the dark theme a faint
 * cyan -> violet glow behind the head). The geometry is the mockup generator's
 * (mockups/emo-core-states/src/page.html: head(), cap, headphones, beanie,
 * antenna, ears, goggles, mic, halo, mortar, bow), rebuilt as 3D buffers.
 *
 * The face (2026-10-22, mockups/bot-face-v3; it replaced the lit grid-node maps): a vector layer on the head's
 * front surface in one of three styles, the viewer's choice (users.joya_bot_face; FACE below): smooth (rounded
 * glyphs, the default), dots (a refined LED dot matrix, snapped per size) or minimal (two pills and a line).
 *   ready (idle)  a smile; slow breathing, a slow yaw sway, a blink every 3-6 s, a glance now and then
 *   listening     taller, wider eyes; the glow pulses with the microphone level
 *   thinking      calm, lidded eyes looking aside; a shimmer sweeps across the head's nodes
 *   speaking      a mouth that opens with the voice (visemes)
 *   delegating    thinking's colour; the eyes and the head turn toward the session, a stream of dots flies there
 *   needs you     big round eyes (a catchlight in smooth), a small "o", amber, a soft double pulse
 *   error/offline red x x and a frown, still
 * A face change morphs the shapes over ~250 ms (colours over ~300 ms): nothing pops.
 *
 * Expressive (2026-10-20, mockups/bot-design-upgrades):
 *   the mouth     speaking: four viseme-like shapes (closed / open / wide / round) mixed into the mouth's shape from
 *                 the voice's spectrum (opts.spec: an AnalyserNode's bytes, viseme()); level only without one
 *   the eyes      follow the pointer (opts.pointer: the window's pointer moves; core.look by hand) and drift back
 *                 when it leaves; glance at a session that needs you or replied (core.glance, cc-map.js)
 *   dozing        idle and 10 quiet minutes, or at night (23:00-06:00 local) after one: lids down, the sleep face,
 *                 slow deep breaths, z z z rising on the left (dozeWanted); a message, a card, voice, typing or
 *                 the pointer near wakes it (core.poke): a blink and a hop
 *   reactions     core.react: surprise (going offline), grin + hops (a job done), nod (approved), wake
 *   eye contact   (2026-10-20, mockups/eye-contact; opt-in camera presence, joya-presence*.js) core.contact({x, y}):
 *                 the eyes meet the person's and follow them as they lean or move; core.presence(state): with the
 *                 camera on, dozing follows presence instead of the timer (away -> it dozes; back -> it wakes and
 *                 looks up; looking -> never; here but not looking -> the night rule only)
 *   still frames  (reduced motion, hold still): the faces only -- a still sleep face, a grin for its moment; no motion
 * The sessions wear their own heads (k.head, cc-logic.js botHeadFor: by role, or the viewer's pin).
 *
 * Same instance contract as joya-core-d.js (cc-map.js, joya-shell.js, joya-dock.js and
 * joya-desktop.js drive both the same way):
 *   var core = window.JoyaCoreBot(canvas, { amp, dest, onFrame, backdrop, kids, beforeDraw, head, colors, face, force2d, noGuard, desk, spec, pointer, now, hour })
 * opts.desk: the desktop app's render mode (?shell=desktop): the page is transparent over the wallpaper, so
 * every head gets a soft contrast backplate (dark under light lines, light under dark ones) and a stronger
 * wireframe; the browser Command Center look is unchanged without it.
 *   core.S.concept === "E" · setState · setLight · resize(cx, cy, R, w, h) · start · stop · still · stats · draw
 *   · place · tick · adopt · destroy · setConcept (no-op) · setHead(id) · setColors({p, c}) · setOffline(bool)
 *   · poke() · react(kind) · glance(point | fn, ms) · look(x, y | null) · presence(state | null) · contact({x, y} | null)
 *   · setFace(style | null) (this core only); JoyaBot.setFace(style) switches the page's default, every live core with it
 * opts.kids(): the Command Center's session spheres (cc-family.js meshKids) -- drawn here as
 * small bot heads in the same style, with their own state in the same colour + face language
 * (JoyaLogic.botSessState): waiting -> needs you, working -> thinking, a delegation landing ->
 * listening, a reply going back -> speaking, just finished -> a grin, idle -> ready; born out of
 * the core's dots, dissolving back into them. The sessions wear their role's head (k.head), else the core's.
 *
 * WebGL2 (lines + point sprites, the face a small SDF program; the glows drawn at quarter resolution and blended up), else a
 * Canvas-2D renderer of the same geometry (also used for the Settings thumbnails: JoyaBot.thumb).
 * DPR <= 2; no allocation per frame (typed arrays reused); the loop stops while the tab is
 * hidden; prefers-reduced-motion and the desktop app's "hold still" (S.still) draw one still
 * frame per change. No eval, no inline style: CSP-safe. Colours come from JoyaLogic.botPalette
 * (cc-logic.js), with the approved Default set built in if that file is not on the page.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") { window.JoyaBot = api; window.JoyaCoreBot = api.create; }
})(typeof self !== "undefined" ? self : this, function () {
  var PI = Math.PI;
  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var KEYS = ["listen", "think", "speak", "deleg", "need", "err"];
  var TARGETS = { idle: {}, listening: { listen: 1 }, thinking: { think: 1 }, delegating: { deleg: 1, think: 0.4 }, speaking: { speak: 1 }, needs: { need: 1 }, error: { err: 1 } };
  var G = 18, GN = G + 1, NF = GN * GN; // the front grid: 19 x 19 nodes, the face maps' pixels
  var MAXK = 12, ROWS = MAXK + 2;        // weight rows: 0 the core, 1.. the sessions
  var STREAM = 420;
  var SMALL = 40; // CSS px head radius below which a head is "small" (sessions, the dock, the companion): a fainter face glow

  /*
   * Speaking mouths: four viseme-like shapes mixed by the voice's spectrum (viseme() below): closed (silence,
   * m b p), open (a), wide (ee, s -- energy high up), round (o u -- energy low down). Each face style turns the
   * mix into its mouth's width, opening and curve (FACE.STY[style].vis), so a change of shape morphs.
   */
  var VIS = ["closed", "open", "wide", "round"];
  function sstep(a, b, x) { x = (x - a) / (b - a); x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
  /** Mean of a byte spectrum's bins between f0 and f1 Hz, above a noise floor, 0..1. */
  function bandOf(bins, hz, f0, f1) {
    var a = Math.max(1, Math.floor(f0 / hz)), b = Math.min(bins.length - 1, Math.ceil(f1 / hz)), s = 0;
    if (b < a) return 0;
    for (var i = a; i <= b; i++) { var v = bins[i] - 70; if (v > 0) s += v; }
    return s / (b - a + 1) / 185;
  }
  /**
   * The mouth shape for this instant: viseme(bins, hz, level, out) -> out {closed, open, wide, round}
   * (they sum to 1). bins: an AnalyserNode's getByteFrequencyData (hz = sampleRate / fftSize per bin), or
   * null: then level only (closed <-> open). How far the mouth opens follows the level; which shape it opens
   * into follows where the energy sits: low (150-600 Hz) round, the middle (0.6-1.8 kHz) open, high up
   * (1.8-9 kHz: ee, s, t) wide. No allocation (out is filled in place).
   */
  function viseme(bins, hz, level, out) {
    out = out || { closed: 1, open: 0, wide: 0, round: 0 };
    level = level > 1 ? 1 : level > 0 ? level : 0;
    var k = sstep(0.06, 0.5, level);
    if (!bins || !hz || !bins.length) { out.closed = 1 - k; out.open = k; out.wide = 0; out.round = 0; return out; }
    var lo = bandOf(bins, hz, 150, 600), mid = bandOf(bins, hz, 600, 1800), hi = bandOf(bins, hz, 1800, 4500) + 1.2 * bandOf(bins, hz, 4500, 9000), tot = lo + mid + hi;
    if (tot < 0.015) { out.closed = 1; out.open = out.wide = out.round = 0; return out; }
    var R = Math.max(0, lo / tot - 0.5) * 2.4, Wd = Math.max(0, hi / tot - 0.3) * 2.6, O = mid / tot + 0.25, n = R + Wd + O;
    out.closed = 1 - k; out.open = k * O / n; out.wide = k * Wd / n; out.round = k * R / n;
    return out;
  }

  /* ------------------------------------------------------------ moods and reactions (2026-10-20) */
  var DOZE_QUIET_MS = 10 * 60 * 1000, NIGHT_QUIET_MS = 60 * 1000;
  function isNight(hour) { return hour >= 23 || hour < 6; }
  /**
   * Should the bot doze? Only when idle and reachable, nobody's pointer near it, and either nothing has
   * happened for 10 minutes or it is night (23:00-06:00 local) and a minute has passed quietly.
   */
  function dozeWanted(o) {
    if (!o || o.state !== "idle" || o.offline || o.near) return false;
    var q = o.quietMs || 0;
    // Eye contact (2026-10-20): with the camera on, presence replaces the 10-minute timer -- it dozes when the
    // person has walked away, never while they look at it, and the night rule still holds while they are
    // here but not looking.
    if (o.presence === "away") return true;
    if (o.presence === "looking") return false;
    if (o.presence === "present") return isNight(o.hour) && q >= NIGHT_QUIET_MS;
    return q >= DOZE_QUIET_MS || (isNight(o.hour) && q >= NIGHT_QUIET_MS);
  }
  // reactions: how long each plays (s); surprise (an error / going offline), grin (a job done), nod (approved), wake
  var REACT = { surprise: 0.9, grin: 1.6, nod: 0.9, wake: 0.6, shake: 0.8 }; // shake (2026-10-21): "didn't recognise your voice"
  /**
   * The core's face and colour item: the state's (FACE_OF), unless a reaction or dozing shows over it.
   * surprise: wide eyes; grin: the grin (in the ready colour, while idle or speaking); dozing (doze > 0.65,
   * idle): the sleep face.
   */
  function pickFace(state, offline, rk, doze) {
    var fo = coreFace(state, offline);
    if (rk === "surprise") return { face: "listen", state: fo.state };
    if (rk === "grin" && !offline && (state === "idle" || state === "speaking")) return { face: "grin", state: "ready" };
    if (!offline && state === "idle" && doze > 0.65 && rk !== "wake") return FACE_SLEEP;
    return fo;
  }
  var FACE_SLEEP = { face: "sleep", state: "ready" };
  /**
   * One dot of the dozing "z z z" (i: 0..29, three z's of ten grid dots: a top bar of four, a two-dot
   * diagonal, a bottom bar of four) at time t: [dx, dy, size, alpha] in head radii, y up. They rise up and
   * to the LEFT of the head (the cap's antenna and the brim are on its right).
   */
  var ZD = [-1.5, 1.5, -0.5, 1.5, 0.5, 1.5, 1.5, 1.5, 0.5, 0.5, -0.5, -0.5, -1.5, -1.5, -0.5, -1.5, 0.5, -1.5, 1.5, -1.5], ZN = 30;
  function zDot(i, t, out) {
    var zi = (i / 10) | 0, d = i % 10, p = (t / 3.6 + zi / 3) % 1, s = 0.05 + 0.035 * p;
    out[0] = -0.98 - 0.36 * p + 0.05 * Math.sin(t * 1.3 + zi * 2.1) + ZD[d * 2] * s;
    out[1] = 0.55 + 0.95 * p + ZD[d * 2 + 1] * s;
    out[2] = 0.55 + 0.6 * p;
    out[3] = Math.sin(PI * p);
    return out;
  }
  /* ------------------------------------------------------------ heads (the mockup's HEADS) */
  var HEADS = {
    cap: { p: 4, yaw: 0.32, acc: ["cap", "headphones", "ant1"] },
    headphones: { p: 5, yaw: 0.25, acc: ["headphones"] },
    beanie: { p: 3.2, yaw: -0.3, acc: ["beanie"] },
    goggles: { p: 4.5, yaw: 0.35, acc: ["goggles"] },
    headset: { p: 4, yaw: 0.3, acc: ["headphones", "mic"] },
    ears: { p: 4, yaw: -0.28, acc: ["ears"] },
    halo: { p: 5, yaw: 0.3, acc: ["halo"] },
    mortar: { p: 4.5, yaw: 0.35, tilt: 0.26, acc: ["mortar"] },
    antennas: { p: 3.6, yaw: -0.25, acc: ["ant2"] },
    bowtie: { p: 6, yaw: 0.3, acc: ["headphones", "bow"] },
  };
  var HEAD_IDS = Object.keys(HEADS);
  /*
   * The Telegram agents' heads (2026-10-25, lib/agent-avatar.js): drawn only as their small still avatars, never by
   * the core, the sessions or the Settings pickers (HEAD_IDS stays the ten); build() knows them.
   */
  var XHEADS = {
    beret: { p: 4, yaw: -0.3, acc: ["beret"] },
    glasses: { p: 4.5, yaw: 0.3, acc: ["glasses"] },
    magnifier: { p: 4, yaw: -0.3, acc: ["magnifier"] },
    pencil: { p: 4.5, yaw: -0.28, acc: ["pencil"] },
    tie: { p: 5, yaw: 0.3, acc: ["headphones", "tie"] },
  };

  /*
   * Vertex: x, y, z (head units: half-width 1), kind, face node (-1 none; the front grid's node index, whose weight
   * hides it under a feature of the face), rnd, size. Kinds: 0 head surface (hidden on the back), 1 accessory,
   * 2 lit accessory (state colour), 3 joint, 4 lit joint, 5 a front node off the drawn grid, 6 antenna rod.
   */
  function Builder(lod, stride) {
    this.v = []; this.lines = []; this.pts = []; this.front = []; this.n = 0; this.lod = lod; this.s = stride; this.seed = 7;
  }
  Builder.prototype.rnd = function () { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; };
  Builder.prototype.add = function (x, y, z, kind, face, size) { this.v.push(x, y, z, kind, face, this.rnd(), size == null ? 1 : size); return this.n++; };
  Builder.prototype.N = function (n) { return Math.max(3, Math.round(n * this.lod)); };
  Builder.prototype.mesh = function (fn, nu, nv, o) {
    o = o || {}; nu = this.N(nu); nv = this.N(nv);
    var P = [], kind = o.kind != null ? o.kind : 1;
    for (var i = 0; i <= nu; i++) { P[i] = []; for (var j = 0; j <= nv; j++) { var q = fn(i / nu, j / nv); P[i][j] = this.add(q[0], q[1], q[2], kind, -1, 1); if (o.nodes !== false) this.pts.push(P[i][j]); } }
    for (i = 0; i <= nu; i++) for (j = 0; j <= nv; j++) {
      var a = P[i][j], b = i < nu ? P[i + 1][j] : o.closeU ? P[0][j] : -1;
      if (b >= 0) this.lines.push(a, b);
      if (j < nv) this.lines.push(a, P[i][j + 1]);
    }
  };
  Builder.prototype.poly = function (pts, lit, js) {
    var prev = -1;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i], v = this.add(q[0], q[1], q[2], lit ? 2 : 6, -1, 1);
      if (prev >= 0) this.lines.push(prev, v);
      prev = v;
      if (i > 0) this.pts.push(this.add(q[0], q[1], q[2], lit ? 4 : 3, -1, js || 7));
    }
  };
  Builder.prototype.head = function (p, ax, ay) {
    var s = this.s;
    for (var fi = 0; fi < 6; fi++) {
      var GG = fi === 0 ? G : Math.round(G / s), st = fi === 0 ? s : 1, idx = [];
      for (var i = 0; i <= GG; i++) {
        idx[i] = [];
        for (var j = 0; j <= GG; j++) {
          var a = i / GG * 2 - 1, b = j / GG * 2 - 1, x, y, z;
          if (fi === 0) { x = a; y = b; z = 1; } else if (fi === 1) { x = 1; y = b; z = -a; } else if (fi === 2) { x = -1; y = b; z = a; }
          else if (fi === 3) { x = a; y = 1; z = -b; } else if (fi === 4) { x = a; y = -1; z = b; } else { x = -a; y = b; z = -1; }
          var k = Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) + Math.pow(Math.abs(z), p), -1 / p);
          var lat = i % st === 0 && j % st === 0, face = fi === 0 ? (G - j) * GN + i : -1;
          var vi = this.add(x * k * ax, y * k * ay, z * k, lat ? 0 : 5, face, 1);
          idx[i][j] = vi;
          if (lat) this.pts.push(vi);
          if (fi === 0) this.front.push(vi);
        }
      }
      for (i = 0; i <= GG; i++) for (j = 0; j <= GG; j++) {
        if (i % st || j % st) continue;
        if (i + st <= GG) this.lines.push(idx[i][j], idx[i + st][j]);
        if (j + st <= GG) this.lines.push(idx[i][j], idx[i][j + st]);
      }
    }
  };
  /* accessories (the mockup's, verbatim in shape) */
  function torusArc(g, c, R0, R1, t0, t1, plane, tube, nu, nv) {
    g.mesh(function (u, v) {
      var t = t0 + (t1 - t0) * u, w = v * 2 * PI, px_ = Math.cos(t) * R0, py = Math.sin(t) * R1, nx = Math.cos(t), ny = Math.sin(t);
      var o0 = nx * Math.cos(w) * tube, o1 = ny * Math.cos(w) * tube, o2 = Math.sin(w) * tube;
      return plane === "xz" ? [c[0] + px_ + o0, c[1] + o2, c[2] + py + o1] : [c[0] + px_ + o0, c[1] + py + o1, c[2] + o2];
    }, nu || 60, nv || 8);
  }
  function cup(g, x, y, side) {
    var r = 0.36, len = 0.2, z = 0;
    g.mesh(function (u, v) { var a = u * 2 * PI; return [x + side * v * len, y + Math.sin(a) * r, z + Math.cos(a) * r]; }, 40, 4, { closeU: false });
    g.mesh(function (u, v) { var a = u * 2 * PI, rr = r * (1 - v * 0.95); return [x + side * len, y + Math.sin(a) * rr, z + Math.cos(a) * rr]; }, 40, 6);
    g.mesh(function (u, v) { var a = u * 2 * PI; return [x + side * (len + 0.06 * Math.sin(v * PI)), y + Math.sin(a) * r * (0.55 + 0.1 * v), z + Math.cos(a) * r * (0.55 + 0.1 * v)]; }, 40, 3);
  }
  var ACC = {
    headphones: function (g, ax, ay) { torusArc(g, [0, ay * 0.05, 0], ax * 1.12, ay * 1.18, 0.05, PI - 0.05, "xy", 0.07); cup(g, ax, 0, 1); cup(g, -ax, 0, -1); },
    cap: function (g, ax, ay) {
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI / 2 * 0.92, rr = Math.cos(b); return [Math.cos(a) * ax * 1.06 * rr, ay * 0.42 + Math.sin(b) * ay * 0.78, Math.sin(a) * 1.06 * rr]; }, 44, 10);
      g.mesh(function (u, v) { var a = -1.15 + 2.3 * u, s = 1.0 + 0.55 * v; return [Math.sin(a) * ax * s * 1.02, ay * 0.45 - 0.12 * v * v, Math.cos(a) * s]; }, 30, 6);
    },
    beanie: function (g, ax, ay) {
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI / 2, rr = Math.cos(b); return [Math.cos(a) * ax * 1.06 * rr, ay * 0.35 + Math.sin(b) * ay * 0.9, Math.sin(a) * 1.06 * rr]; }, 44, 12);
      g.mesh(function (u, v) { var a = u * 2 * PI; return [Math.cos(a) * ax * 1.1, ay * 0.3 + v * 0.22, Math.sin(a) * 1.1]; }, 44, 3);
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI; return [Math.cos(a) * Math.sin(b) * 0.16, ay * 1.32 + Math.cos(b) * 0.16, Math.sin(a) * Math.sin(b) * 0.16]; }, 16, 8);
    },
    ant1: function (g, ax, ay) { g.poly([[0.35, ay * 1.18, 0], [0.55, ay * 1.75, -0.1], [0.95, ay * 1.45, -0.1], [1.25, ay * 2.0, -0.2]], false); },
    ant2: function (g, ax, ay) { g.poly([[-0.4, ay * 1.0, 0], [-0.6, ay * 1.6, -0.1], [-0.85, ay * 1.95, -0.1]], true); g.poly([[0.4, ay * 1.0, 0], [0.6, ay * 1.6, -0.1], [0.85, ay * 1.95, -0.1]], true); },
    ears: function (g, ax, ay) { [-1, 1].forEach(function (s) { g.mesh(function (u, v) { var a = u * 2 * PI, rr = (1 - v) * 0.32; return [s * (ax * 0.55) + Math.cos(a) * rr * 1.1 + s * v * 0.12, ay * 0.75 + v * 0.75, Math.sin(a) * rr * 0.6]; }, 14, 6); }); },
    goggles: function (g, ax, ay) { [-1, 1].forEach(function (s) { torusArc(g, [s * 0.42, ay * 0.8, 0.72], 0.3, 0.3, 0, 2 * PI, "xy", 0.07, 40); }); torusArc(g, [0, ay * 0.8, 0], ax * 1.05, 1.05, -0.1, PI + 0.1, "xz", 0.04, 50); },
    mic: function (g, ax, ay) {
      g.poly([[-ax * 1.15, 0, 0.15], [-ax * 1.05, -0.45, 0.7], [-ax * 0.6, -0.62, 1.05], [-ax * 0.3, -0.62, 1.12]], false);
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI; return [-ax * 0.22 + Math.cos(a) * Math.sin(b) * 0.1, -0.62 + Math.cos(b) * 0.1, 1.14 + Math.sin(a) * Math.sin(b) * 0.1]; }, 14, 8, { kind: 2 });
    },
    halo: function (g, ax, ay) { torusArc(g, [0, ay * 1.4, 0], ax * 0.85, 0.85, 0, 2 * PI, "xz", 0.06, 60); },
    mortar: function (g, ax, ay) {
      g.mesh(function (u, v) { return [(-1 + 2 * u) * ax * 1.25, ay * 1.18, (-1 + 2 * v) * 1.15]; }, 14, 14);
      g.mesh(function (u, v) { var a = u * 2 * PI; return [Math.cos(a) * ax * 0.85, ay * 0.55 + v * 0.62, Math.sin(a) * 0.85]; }, 40, 5);
      g.poly([[0, ay * 1.2, 0], [ax * 0.95, ay * 1.18, 0.6], [ax * 1.05, ay * 0.55, 0.75]], true);
    },
    bow: function (g, ax, ay) { [-1, 1].forEach(function (s) { g.mesh(function (u, v) { var a = -1 + 2 * u; return [s * (0.08 + 0.38 * v), -ay * 1.08 + a * (0.08 + 0.22 * v), 1.0 - 0.1 * v]; }, 6, 6); }); },
    /* the Telegram agents' own accessories (2026-10-25, lib/agent-avatar.js; XHEADS below) */
    beret: function (g, ax, ay) {
      var by = function (c) { return ay * 0.86 - 0.2 * c; }; // the brim's height: lower on the side it leans to
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI / 2, rr = Math.cos(b), c = Math.cos(a); return [0.2 + c * ax * 1.3 * rr, by(c * rr) + Math.sin(b) * 0.4, Math.sin(a) * 1.18 * rr]; }, 40, 6);
      g.mesh(function (u, v) { var a = u * 2 * PI, w = v * 2 * PI, t = 0.05, c = Math.cos(a); return [0.2 + c * (ax * 1.3 + Math.cos(w) * t), by(c) + Math.sin(w) * t, Math.sin(a) * (1.18 + Math.cos(w) * t)]; }, 40, 1, { kind: 2 });
      g.poly([[0.2, ay * 0.86 + 0.4, 0], [0.26, ay * 0.86 + 0.58, -0.02]], true);
    },
    glasses: function (g, ax, ay) {
      [-1, 1].forEach(function (s) { g.mesh(function (u, v) { var a = u * 2 * PI, w = v * 2 * PI, t = 0.035; return [s * 0.4 + Math.cos(a) * (0.25 + Math.cos(w) * t), 0.06 + Math.sin(a) * (0.21 + Math.cos(w) * t), 1.06 + Math.sin(w) * t]; }, 32, 4, { kind: 2 }); });
      g.poly([[-0.15, 0.1, 1.07], [0, 0.14, 1.08], [0.15, 0.1, 1.07]], true);
      [-1, 1].forEach(function (s) { g.poly([[s * 0.65, 0.08, 1.04], [s * 1.0, 0.1, 0.62], [s * 1.04, 0.06, 0.2]], false); });
    },
    magnifier: function (g, ax, ay) {
      g.poly([[0.32, ay * 1.0, 0], [0.48, ay * 1.42, -0.05]], false);
      g.mesh(function (u, v) { var a = u * 2 * PI, w = v * 2 * PI, t = 0.05; return [0.62 + Math.cos(a) * (0.3 + Math.cos(w) * t), ay * 1.78 + Math.sin(a) * (0.3 + Math.cos(w) * t), -0.08 + Math.sin(w) * t]; }, 36, 4, { kind: 2 });
    },
    pencil: function (g, ax, ay) {
      var A = [0.15, ay * 0.98, -0.1], B = [1.05, ay * 1.56, -0.25], T = [1.3, ay * 1.72, -0.29];
      g.mesh(function (u, v) { var w = v * 2 * PI, r = 0.08; return [A[0] + (B[0] - A[0]) * u - Math.sin(w) * r * 0.55, A[1] + (B[1] - A[1]) * u + Math.sin(w) * r * 0.85, A[2] + (B[2] - A[2]) * u + Math.cos(w) * r]; }, 10, 8);
      g.mesh(function (u, v) { var w = v * 2 * PI, r = 0.08 * (1 - u); return [B[0] + (T[0] - B[0]) * u - Math.sin(w) * r * 0.55, B[1] + (T[1] - B[1]) * u + Math.sin(w) * r * 0.85, B[2] + (T[2] - B[2]) * u + Math.cos(w) * r]; }, 4, 8, { kind: 2 });
    },
    tie: function (g, ax, ay) {
      g.mesh(function (u, v) { var a = -1 + 2 * u; return [a * 0.12, -ay * 1.04 - v * 0.14, 0.98]; }, 4, 3, { kind: 2 });
      g.mesh(function (u, v) { var y = -ay * 1.18 - v * 0.6, w = v < 0.8 ? 0.1 + 0.12 * v / 0.8 : 0.22 * (1 - v) / 0.2; return [(-1 + 2 * u) * w, y, 0.96 - 0.08 * v]; }, 4, 8, { kind: 2 });
    },
  };
  var geoCache = {};
  /** The head's buffers. detail "hi": every grid line; "lo" (sessions, the dock): every other line, half the accessory rings. */
  function build(head, detail) {
    head = HEADS[head] || XHEADS[head] ? head : "cap";
    var key = head + ":" + detail;
    if (geoCache[key]) return geoCache[key];
    var hi = detail === "hi", cfg = HEADS[head] || XHEADS[head], g = new Builder(hi ? 1 : 0.5, hi ? 1 : 2), ax = 1, ay = 0.98;
    g.head(cfg.p, ax, ay);
    cfg.acc.forEach(function (a) { ACC[a](g, ax, ay); });
    var out = { head: head, cfg: cfg, v: new Float32Array(g.v), lines: new Uint16Array(g.lines), pts: new Uint16Array(g.pts), front: new Uint16Array(g.front), n: g.n };
    geoCache[key] = out;
    return out;
  }

  /* ------------------------------------------------------------ colours */
  var DEF = {
    dark: { ready: [0, 230, 165], listening: [56, 214, 255], thinking: [150, 110, 255], speaking: [255, 90, 200], needs: [255, 190, 60], error: [255, 80, 80], wire: [225, 232, 248], wireK: 1, rim: [[56, 214, 255], [150, 110, 255]], rimL: [109, 43, 200] },
    light: { ready: [0, 120, 90], listening: [0, 110, 170], thinking: [109, 43, 200], speaking: [190, 30, 140], needs: [180, 105, 0], error: [200, 30, 30], wire: [38, 46, 64], wireK: 1, rim: [[56, 214, 255], [150, 110, 255]], rimL: [109, 43, 200] },
  };
  function logic() { return typeof window !== "undefined" && window.JoyaLogic ? window.JoyaLogic : null; }
  function palettes(colors) {
    var L = logic();
    if (L && L.botPalette) return { dark: L.botPalette(colors, false), light: L.botPalette(colors, true) };
    return { dark: DEF.dark, light: DEF.light };
  }
  function sessState(k) {
    var L = logic();
    if (L && L.botSessState) return L.botSessState(k);
    if (k.st === "waiting") return { state: "needs", face: "pupils" };
    if (k.st === "working") return { state: "thinking", face: "focus" };
    return { state: "ready", face: "base" };
  }
  var FACE_OF = {
    idle: { state: "ready", face: "base" }, listening: { state: "listening", face: "listen" }, thinking: { state: "thinking", face: "focus" },
    delegating: { state: "thinking", face: "base" }, speaking: { state: "speaking", face: "speak" }, needs: { state: "needs", face: "pupils" }, error: { state: "error", face: "err" },
  };
  function coreFace(st, offline) { return offline ? FACE_OF.error : FACE_OF[st] || FACE_OF.idle; }

  /* ------------------------------------------------------------ one head's life: face, colour, blink, glance */
  function Anim(seed) {
    this.face = "base"; this.prev = "base"; this.fk = 1;
    this.col = "ready"; this.pcol = [0, 0, 0]; this.ck = 1; this.rgb = [0, 0, 0];
    var s = seed || 1;
    this.r = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    this.blinkAt = 1.5 + this.r() * 3; this.blinkP = -1; this.glanceAt = 4 + this.r() * 4; this.glanceUntil = 0;
    this.gx = 0; this.gy = 0; this.gxT = 0; this.gyT = 0; this.ph = this.r() * 6.28; this.t = 0; this.seen = 0; this.fresh = true; this.lid = 1;
  }
  Anim.prototype.set = function (face, col) {
    if (this.fresh) { this.fresh = false; this.face = this.prev = face; this.col = col; this.fk = this.ck = 1; this.pcol[0] = -1; return; }
    if (face !== this.face) {
      if (face === this.prev) { this.prev = this.face; this.face = face; this.fk = 1 - this.fk; } // straight back: reverse the fade, no jump
      else { if (this.fk >= 0.5) this.prev = this.face; this.face = face; this.fk = 0; }
    }
    if (col !== this.col) { this.pcol[0] = this.rgb[0]; this.pcol[1] = this.rgb[1]; this.pcol[2] = this.rgb[2]; this.col = col; this.ck = 0; }
  };
  Anim.prototype.step = function (dt, calm, idle) {
    this.t += dt;
    this.fk = Math.min(1, this.fk + dt / 0.25); this.ck = Math.min(1, this.ck + dt / 0.3);
    if (calm) { this.blinkP = -1; } else {
      if (this.blinkP >= 0) { this.blinkP += dt / 0.16; if (this.blinkP >= 1) { this.blinkP = -1; this.blinkAt = this.t + 3 + this.r() * 3; } }
      else if (this.t > this.blinkAt) this.blinkP = 0;
      if (idle && this.t > this.glanceAt) { this.glanceAt = this.t + 4 + this.r() * 5; this.glanceUntil = this.t + 0.7 + this.r() * 0.6; this.glx = this.r() < 0.5 ? -1.6 : 1.6; this.gly = this.r() < 0.3 ? -1 : 0; }
    }
  };
  Anim.prototype.blink = function () { var b = this.blinkP < 0 ? 1 : 1 - 0.95 * Math.sin(Math.min(1, this.blinkP) * PI); return b < this.lid ? b : this.lid; };
  Anim.prototype.settle = function () { this.fk = 1; this.ck = 1; this.blinkP = -1; this.gx = this.gxT; this.gy = this.gyT; };
  Anim.prototype.color = function (pal) {
    var c = pal[this.col] || pal.ready, k = this.ck * this.ck * (3 - 2 * this.ck);
    if (this.pcol[0] < 0) k = 1; // a fresh head: its colour at once
    this.rgb[0] = this.pcol[0] + (c[0] - this.pcol[0]) * k; this.rgb[1] = this.pcol[1] + (c[1] - this.pcol[1]) * k; this.rgb[2] = this.pcol[2] + (c[2] - this.pcol[2]) * k;
    return this.rgb;
  };
  /* ------------------------------------------------------------ shaders */
  var WIRE_VS = [
    "#version 300 es",
    "precision highp float;",
    "layout(location=0) in vec3 a_p; layout(location=1) in vec4 a_i;",
    "uniform vec2 u_res,u_c,u_home; uniform vec3 u_wire,u_st; uniform sampler2D u_wt;",
    "uniform float u_r,u_fs,u_sc,u_yaw,u_tilt,u_form,u_dis,u_row,u_wa,u_lit,u_alpha,u_mode,u_psz,u_jsz,u_shimX,u_shimA,u_maxPt,u_ind,u_arm,u_indA;",
    "out vec4 v_c; out float v_j;",
    "float wt(float f){ if(f<0.0) return 0.0; return texelFetch(u_wt,ivec2(int(f+0.5),int(u_row+0.5)),0).r; }",
    "float h1(float n){ return fract(sin(n*91.7+7.3)*43758.5453); }",
    "void main(){",
    " int kind=int(a_i.x+0.5); float rnd=a_i.z; vec3 p=a_p;",
    " float cy=cos(u_yaw),sy=sin(u_yaw),ct=cos(u_tilt),st=sin(u_tilt);",
    " float x1=p.x*cy+p.z*sy, z1=-p.x*sy+p.z*cy; float y2=p.y*ct-z1*st, z2=z1*ct+p.y*st;",
    " vec2 px=u_c+vec2(x1,y2)*u_r*u_sc;",
    " if(u_form<1.0){ float pp=clamp((u_form-rnd*0.45)/0.55,0.0,1.0); pp=pp*pp*(3.0-2.0*pp); vec2 m=(u_home+px)*0.5+vec2(rnd-0.5,h1(rnd)-0.5)*u_r*3.0; float u=1.0-pp; px=u*u*u_home+2.0*u*pp*m+pp*pp*px; }",
    " if(u_dis>0.0){ float q=clamp((u_dis-rnd*0.4)/0.6,0.0,1.0); q=q*q*(3.0-2.0*q); vec2 m=(u_home+px)*0.5+vec2(h1(rnd)-0.5,rnd-0.5)*u_r*4.0*sin(q*3.14159); float u=1.0-q; px=u*u*px+2.0*u*q*m+q*q*u_home; }",
    " float d=clamp((z2+1.0)*0.5,0.0,1.0);",
    " float vis=(kind==0||kind==5)?smoothstep(-0.03,0.07,z2):1.0;",
    " float sh=u_shimA*exp(-pow((p.x-u_shimX)/0.22,2.0))*(0.6+0.4*rnd);",
    " vec3 col=u_wire; float a=0.0, size=1.0; v_j=0.0;",
    " if(u_mode<0.5){",                                             // the wireframe
    "  a=(0.05+0.28*d*d)*u_wa; if(kind==6) a=0.55*u_wa;",
    "  if(kind==2||kind==4){ col=u_st; a=0.9*u_lit; }",
    "  a+=sh*0.3; col=mix(col,u_st,clamp(sh,0.0,1.0)*0.6);",
    "  a*=smoothstep(0.95,1.0,u_form)*(1.0-smoothstep(0.0,0.1,u_dis));",
    " } else {",                                                    // the grid nodes (and joints); hidden under the face's features
    "  float w=wt(a_i.y);",
    "  a=(0.08+0.35*d*d)*u_wa*1.2*(1.0-w); size=(0.6+1.7*d)*u_psz;",
    "  if(kind==5) a=0.0;",
    "  if(kind==3){ a=0.8*min(1.0,u_wa); size=u_jsz; v_j=1.0; }",
    "  if(kind==4){ col=u_st; a=u_lit; size=u_jsz*0.85; }",
    "  if(kind==2){ col=u_st; a=0.6*u_lit; }",
    "  a+=sh*0.6*(1.0-w); col=mix(col,u_st,clamp(sh,0.0,1.0)*0.7); size*=1.0+sh*0.7;",
    " }",
    // look and speak (2026-10-21): the front face's outer rows of nodes light clockwise from the top (head space, so
    // the order holds as the head turns) as the look is held (u_arm), all of them when ready; u_indA their strength
    " if(u_ind>0.5&&u_mode>0.5&&u_mode<1.5&&kind==0){",
    "  float e=max(abs(p.x),abs(p.y)/0.98); float rim=smoothstep(0.7,0.86,e)*step(0.25,p.z);",
    "  float f=fract(atan(p.x,p.y)/6.2831853+1.0);",
    "  float on=clamp((u_arm-f)*40.0,0.0,1.0); float lead=u_arm<0.999?exp(-pow((u_arm-f)*16.0,2.0)):0.0;",
    "  float k=rim*(on*u_indA+lead*0.9);",
    "  a=max(a,k); col=mix(col,u_st,clamp(k*1.5,0.0,1.0)); size*=1.0+1.2*k; if(lead*rim>0.45) v_j=1.0;",
    " }",
    " a*=vis*u_alpha;",
    " if(u_form<1.0) a*=0.4+0.6*u_form;",
    " if(u_dis>0.0) a*=1.0-u_dis*0.85;",
    " v_c=vec4(col,clamp(a,0.0,1.0));",
    " px*=u_fs;",
    " gl_Position=(u_mode>0.5&&a<=0.003)?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0);",
    " size=clamp(size*u_fs,1.0,u_maxPt);",
    " gl_PointSize=size;",
    "}",
  ].join("\n");
  var WIRE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec4 v_c; in float v_j; uniform float u_pt,u_soft,u_sq,u_mode; out vec4 o;",
    "void main(){ float a=v_c.a; vec3 c=v_c.rgb;",
    " if(u_pt>0.5&&!(u_sq>0.5&&u_mode>1.5&&u_mode<3.5)){ vec2 q=gl_PointCoord*2.0-1.0; float r2=dot(q,q); if(r2>1.0) discard;",
    "  a*=u_soft>0.5?exp(-r2*3.2):smoothstep(1.0,0.55,r2);",
    "  if(v_j>0.5&&r2<0.42){ c=vec3(1.0); a=max(a,0.9*v_c.a); } }",
    " o=vec4(c*a,a); }",
  ].join("\n");
  var QUAD_VS = [
    "#version 300 es",
    "uniform vec4 u_box; uniform vec2 u_res;",
    "void main(){ int i=gl_VertexID; vec2 c=vec2((i==1||i==4||i==5)?1.0:0.0,(i==2||i==3||i==5)?1.0:0.0);",
    " vec2 p=mix(u_box.xy,u_box.zw,c); gl_Position=vec4(p/u_res*2.0-1.0,0.0,1.0); }",
  ].join("\n");
  var QUAD_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_c,u_so; uniform float u_r,u_rimK,u_stK; uniform vec3 u_rA,u_rB,u_st; out vec4 o;",
    "void main(){ vec2 d=(gl_FragCoord.xy-u_c)/u_r; float L=length(d);",
    " float rim=u_rimK*(1.0-smoothstep(0.45,1.6,L)); vec3 rc=mix(u_rA,u_rB,clamp(d.x*0.45+0.5,0.0,1.0));",
    " float sg=u_stK*(1.0-smoothstep(0.15,1.05,length(d-u_so)));",
    " o=vec4(rc*rim+u_st*sg,rim+sg-rim*sg); }",
  ].join("\n");
  var COMP_VS = "#version 300 es\nvoid main(){ int i=gl_VertexID; vec2 p=vec2(i==1?3.0:-1.0,i==2?3.0:-1.0); gl_Position=vec4(p,0.0,1.0); }";
  var COMP_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_tex; uniform vec2 u_res,u_tx; uniform float u_k; out vec4 o;",
    "void main(){ vec2 uv=gl_FragCoord.xy/u_res;",
    " vec4 c=texture(u_tex,uv+vec2(-0.75,-0.75)*u_tx)+texture(u_tex,uv+vec2(0.75,-0.75)*u_tx)+texture(u_tex,uv+vec2(-0.75,0.75)*u_tx)+texture(u_tex,uv+vec2(0.75,0.75)*u_tx);",
    " c*=0.25; o=vec4(c.rgb,c.a*u_k); }",
  ].join("\n");
  /* the desktop's contrast backplate: a soft disc of one colour, full to 45 % of its radius, gone at its edge */
  var PLATE_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_c; uniform float u_r; uniform vec4 u_col; out vec4 o;",
    "void main(){ float L=length(gl_FragCoord.xy-u_c)/u_r; float a=u_col.a*(1.0-smoothstep(0.45,1.0,L)); o=vec4(u_col.rgb*a,a); }",
  ].join("\n");
  var PLATE = { dark: [8, 11, 18], light: [250, 251, 253], aDark: 0.76, aLight: 0.72, core: 1.8, kid: 1.7 };
  var STREAM_VS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_res,u_c,u_dest; uniform float u_r,u_bead,u_deleg,u_psz; uniform vec3 u_st;",
    "out vec4 v_c; out float v_j;",
    "vec4 h4(float n){ return fract(sin(vec4(n*12.9898,n*78.233,n*37.719,n*93.989))*43758.5453); }",
    "void main(){ vec4 h=h4(float(gl_VertexID)+333.0); float s=fract(u_bead*(0.85+0.3*h.x)+h.y); float e=s*s*(3.0-2.0*s);",
    " vec2 dv0=u_dest-u_c; float L=max(length(dv0),1.0); vec2 dir=dv0/L;",
    " vec2 P0=u_c+dir*u_r*0.9+(h.zw-0.5)*u_r*0.5; vec2 P2=u_dest+(h.zw-0.5)*max(u_r*0.12,6.0);",
    " vec2 dv=P2-P0; vec2 pr=vec2(-dv.y,dv.x); vec2 P1=(P0+P2)*0.5+pr*(0.16+0.1*(h.w-0.5)); float q=1.0-e;",
    " vec2 px=q*q*P0+2.0*q*e*P1+e*e*P2;",
    " float a=u_deleg*u_deleg*pow(sin(3.14159*s),0.5)*(0.5+0.5*h.z)*1.6;",
    " v_c=vec4(mix(u_st,vec3(1.0),0.2*e),clamp(a,0.0,1.0)); v_j=0.0;",
    " gl_Position=a<0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0); gl_PointSize=u_psz*(0.9+1.2*h.w); }",
  ].join("\n");

  /* the dozing "z z z": 21 square dots (three z's of seven, zDot's twin), rising up and to the right of the head */
  var ZZZ_VS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_res,u_c; uniform float u_r,u_t,u_k,u_psz; uniform vec3 u_st;",
    "out vec4 v_c; out float v_j;",
    "const float ZD[20]=float[20](-1.5,1.5,-0.5,1.5,0.5,1.5,1.5,1.5,0.5,0.5,-0.5,-0.5,-1.5,-1.5,-0.5,-1.5,0.5,-1.5,1.5,-1.5);",
    "void main(){ int i=gl_VertexID; int zi=i/10; int d=i-zi*10; float p=fract(u_t/3.6+float(zi)/3.0); float s=0.05+0.035*p;",
    " vec2 q=vec2(-0.98-0.36*p+0.05*sin(u_t*1.3+float(zi)*2.1)+ZD[d*2]*s, 0.55+0.95*p+ZD[d*2+1]*s);",
    " float a=u_k*sin(3.14159*p); v_c=vec4(u_st,clamp(a,0.0,1.0)); v_j=0.0;",
    " vec2 px=u_c+q*u_r; gl_Position=a<0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0); gl_PointSize=max(2.0,floor(u_psz*(0.55+0.6*p)+0.5)); }",
  ].join("\n");

  /* ------------------------------------------------------------ the face (2026-10-22, mockups/bot-face-v3)
   * The eyes and mouth are a vector face layer, not lit grid nodes. One parametric face (two mirrored eyes and a
   * mouth, each a signed distance field in face space: a = across, b = up, the front grid's own coordinates,
   * -1..1) is drawn on a patch that sits on the head's front surface, so it turns, tilts, nods and shakes with the
   * head. Expressions are parameter sets and morph into one another; blink, glance / gaze and the voice's visemes
   * act on the parameters. Three looks, the viewer's choice (users.joya_bot_face):
   *   smooth   rounded-rect eyes, a smooth arc mouth, anti-aliased (fwidth), a soft glow (the default)
   *   dots     the same shapes sampled on a symmetric LED grid whose pitch is picked per device size
   *            (12 / 16 / 22 / 30 / 40 dots across the face), every shape snapped to whole dots
   *   minimal  two soft pills and a thin line, a wider calmer glow
   * The grid nodes under a feature are hidden (their weight row holds the feature's coverage). The 2D renderer (the
   * fallback, the Settings thumbnails) draws the same shapes as vector paths through the head's exact projection.
   */
  var FACE = (function () {
    var N = 28;
    var EX = 0, EY = 1, EW = 2, EH = 3, ER = 4, LT = 5, LB = 6, CA = 7, AW = 8, AC = 9, XW = 10, ET = 11, MW = 12, MY = 13, MH = 14, MC = 15, MT = 16, MV = 17, OX = 18, OY = 19, PI_ = 20, GW = 21, DOTS = 22, GK = 23, AO = 24;
    var KEYS_ = { ex: EX, ey: EY, ew: EW, eh: EH, er: ER, lt: LT, lb: LB, ca: CA, aw: AW, ac: AC, xw: XW, et: ET, mw: MW, my: MY, mh: MH, mc: MC, mt: MT, mv: MV, ox: OX, oy: OY };
    var ZERO = { ex: 0.4, ey: 0.13, ew: 0.14, eh: 0.18, er: 0.6, lt: 0, lb: 0, ca: 0, aw: 0, ac: 0, xw: 0, et: 0.035, mw: 0.2, my: -0.37, mh: 0, mc: 0.06, mt: 0.034, mv: 1, ox: 0, oy: 0 };
    function vec(o, base) { var v = new Float32Array(N), k; for (k in KEYS_) v[KEYS_[k]] = o[k] != null ? o[k] : base && base[k] != null ? base[k] : ZERO[k]; return v; }
    function set(base, faces) { var out = {}; Object.keys(faces).forEach(function (f) { var o = {}, k; for (k in base) o[k] = base[k]; for (k in faces[f]) o[k] = faces[f][k]; out[f] = vec(o); }); return out; }

    /* ---- the three looks: per face name (the renderer's: base, listen, focus, speak, pupils, err, sleep, grin) */
    var A0 = { ex: 0.4, ey: 0.13, ew: 0.14, eh: 0.18, er: 0.62, mw: 0.2, my: -0.37, mc: 0.06, mt: 0.034 };
    var STY = {
      smooth: {
        faces: set(A0, {
          base: {},
          listen: { ew: 0.152, eh: 0.215, ey: 0.15, er: 0.66, mw: 0.095, mc: 0.012 },
          focus: { ew: 0.15, eh: 0.17, lt: 0.44, ey: 0.11, ox: -0.035, oy: 0.025, mw: 0.11, mc: 0, my: -0.38 },
          speak: {},
          pupils: { ew: 0.165, eh: 0.205, er: 0.85, ca: 0.05, ey: 0.14, mw: 0.05, mh: 0.045, mt: 0.03, mc: 0, my: -0.4 },
          err: { xw: 1, ew: 0.11, eh: 0.11, et: 0.036, ey: 0.13, mw: 0.16, mc: -0.05, my: -0.41 },
          sleep: { aw: 1, ac: -1, ew: 0.135, eh: 0.075, et: 0.032, ey: 0.06, mw: 0.05, mc: 0, mt: 0.03, my: -0.37 },
          grin: { aw: 1, ac: 1, ew: 0.14, eh: 0.1, et: 0.04, ey: 0.15, mw: 0.24, mh: 0.085, mc: 0.085, my: -0.31 },
        }),
        vis: { closed: [0.19, 0, 0.03], open: [0.15, 0.1, 0], wide: [0.25, 0.05, 0.03], round: [0.075, 0.085, 0] },
        gw: 0.2, gk: 1, smallK: 0.3, small: 1,
      },
      dots: {
        faces: set({ ex: 0.4, ey: 0.14, ew: 0.15, eh: 0.2, er: 0.55, mw: 0.22, my: -0.38, mc: 0.07, mt: 0.04 }, {
          base: {},
          listen: { ew: 0.16, eh: 0.24, er: 0.6, mw: 0.09, mc: 0 },
          focus: { ew: 0.16, eh: 0.2, lt: 0.5, ey: 0.12, ox: -0.05, mw: 0.12, mc: 0 },
          speak: {},
          pupils: { ew: 0.22, eh: 0.22, er: 0.75, mw: 0.06, mh: 0.1, mc: 0, my: -0.43 }, // round, wider than listening, an open o
          err: { xw: 1, ew: 0.14, eh: 0.14, et: 0.04, mw: 0.18, mc: -0.06 },
          sleep: { aw: 1, ac: -1, ew: 0.15, eh: 0.08, ey: 0.06, mw: 0.05, mc: 0 },
          grin: { aw: 1, ac: 1, ew: 0.15, eh: 0.1, ey: 0.16, mw: 0.25, mh: 0.1, mc: 0.1, my: -0.32 },
        }),
        vis: { closed: [0.2, 0, 0.03], open: [0.16, 0.11, 0], wide: [0.27, 0.06, 0.03], round: [0.08, 0.1, 0] },
        gw: 0.16, gk: 0.8, smallK: 0, small: 0.7, dots: true,
      },
      minimal: {
        faces: set({ ex: 0.31, ey: 0.11, ew: 0.078, eh: 0.165, er: 1, mw: 0.12, my: -0.36, mc: 0.016, mt: 0.021, et: 0.022 }, {
          base: {},
          listen: { ew: 0.086, eh: 0.205, ey: 0.13, mw: 0.075, mc: 0 },
          focus: { ew: 0.09, eh: 0.072, ey: 0.09, ox: -0.035, mw: 0.09, mc: 0 },
          speak: {},
          pupils: { ew: 0.095, eh: 0.18, ey: 0.12, mw: 0.022, mt: 0.026, mc: 0 },
          err: { xw: 1, ew: 0.072, eh: 0.072, et: 0.021, mw: 0.1, mc: -0.035 },
          sleep: { aw: 1, ac: -1, ew: 0.09, eh: 0.04, ey: 0.05, mv: 0 },
          grin: { aw: 1, ac: 1, ew: 0.09, eh: 0.06, et: 0.024, ey: 0.12, mw: 0.16, mc: 0.055, mt: 0.022 },
        }),
        vis: { closed: [0.12, 0, 0.014], open: [0.1, 0.06, 0], wide: [0.15, 0.03, 0.012], round: [0.05, 0.05, 0] },
        gw: 0.3, gk: 1.2, smallK: 0.45, small: 1,
      },
    };
    var NAMES = { smooth: "Smooth", dots: "Dot matrix", minimal: "Minimal" };
    /** A face style as itself (any case), else the default, smooth. */
    function norm(s) { s = typeof s === "string" ? s.toLowerCase() : ""; return Object.prototype.hasOwnProperty.call(STY, s) ? s : "smooth"; }

    /* ---- the B grid: dots across the face (2 units), picked so a dot is >= ~5 device px; then the shapes snap */
    var DOTN = [40, 30, 22, 16, 12];
    function pitchFor(cssR, dpr) {
      var unit = cssR * dpr; // device px per face unit
      for (var i = 0; i < DOTN.length; i++) if (2 * unit / DOTN[i] >= 5.2) return 2 / DOTN[i];
      return 2 / DOTN[DOTN.length - 1];
    }
    function snapCount(hw, p, min) { return Math.max(min || 1, Math.round(2 * hw / p)); }
    function snapPos(x, p, n) { return n % 2 ? Math.round(x / p) * p : (Math.floor(x / p) + 0.5) * p; }
    function snapDots(v, p) {
      var nW = snapCount(v[EW], p), nH = snapCount(v[EH], p);
      if (v[XW] > 0.5) { nW = nH = Math.max(3, nW | 1); } // an x: odd and square, so its arms meet on a dot
      v[EX] = snapPos(v[EX], p, nW); v[EY] = snapPos(v[EY], p, nH);
      v[EW] = (nW / 2 - 0.5) * p + 0.32 * p; v[EH] = (nH / 2 - 0.5) * p + 0.32 * p;
      v[ET] = 0.52 * p; v[CA] = 0;
      // arcs: whole dots wide, the peak on a row and the ends exactly one (or more) rows lower -- no half-lit rows
      if (v[AW] > 0.5) { v[EW] = Math.max(1, Math.round(v[EW] / p)) * p; v[EH] = Math.max(1, Math.round(v[EH] / p)) * p; v[AO] = 1; v[ET] = 0.45 * p; v[EX] = Math.round(v[EX] / p) * p; v[EY] = Math.round(v[EY] / p) * p; }
      var nM = 2 * Math.max(1, Math.round(v[MW] / p)) + 1;
      v[MW] = (nM / 2 - 0.5) * p + 0.32 * p; v[MY] = Math.round(v[MY] / p) * p; v[MT] = 0.5 * p;
      v[MH] = Math.round(v[MH] / p) * p;
      // a curve shallower than a dot reads as noise on a coarse grid: flat, or a whole row
      v[MC] = p > 0.1 ? (Math.abs(v[MC]) < 0.5 * p ? 0 : (v[MC] < 0 ? -1 : 1) * p) : Math.round(v[MC] / p * 2) * p / 2;
      v[OX] = Math.round(v[OX] / p) * p; v[OY] = Math.round(v[OY] / p) * p;
    }

    /* ---- one face vector: the anim's face morphing from its previous one, the voice, blink, gaze, size */
    var TA = new Float32Array(N), TB = new Float32Array(N);
    function faceOf(T, name, vm, amp, out) {
      var src = T.faces[name] || T.faces.base;
      for (var i = 0; i < 20; i++) out[i] = src[i];
      if (name === "speak") {
        var V = T.vis, c, o, w, r;
        if (vm) { c = vm.closed; o = vm.open; w = vm.wide; r = vm.round; } else { o = Math.max(0, Math.min(1, amp * 1.6)); c = 1 - o; w = r = 0; }
        var s = c + o + w + r || 1;
        out[MW] = (c * V.closed[0] + o * V.open[0] + w * V.wide[0] + r * V.round[0]) / s;
        out[MH] = (c * V.closed[1] + o * V.open[1] + w * V.wide[1] + r * V.round[1]) / s;
        out[MC] = (c * V.closed[2] + o * V.open[2] + w * V.wide[2] + r * V.round[2]) / s;
      }
      return out;
    }
    function sm(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
    /**
     * vecFor(style, an, cssR, dpr, amp, vm, out, W8, off): out <- the face vector; W8[off ..] <- the front nodes'
     * coverage (hides the grid under the features).
     */
    function vecFor(st, an, cssR, dpr, amp, vm, out, W8, off) {
      var T = STY[st] || STY.smooth;
      var A = faceOf(T, an.face, vm, amp, TA), P = faceOf(T, an.prev, vm, amp, TB), k = sm(an.fk);
      for (var i = 0; i < 20; i++) out[i] = P[i] + (A[i] - P[i]) * k;
      var bl = an.blink();
      if (out[AW] < 0.5) out[EH] = Math.max(out[EH] * bl, 0.018); // shut: a short line (arcs and sleep do not blink)
      out[OX] += clamp(an.gx, -2.2, 2.2) * 0.075; out[OY] += -an.gy * 0.07;
      var smallness = clamp((44 - cssR) / 28, 0, 1), sc = 1 + T.smallK * smallness;
      out[EW] *= sc; out[EH] *= sc; out[MW] *= sc; out[MH] *= sc; out[MT] *= sc; out[ET] *= sc; out[CA] *= sc;
      if (smallness > 0.5) out[CA] = 0; // a catchlight under ~30 px is noise
      var mp = 1 / Math.max(1, cssR * dpr); // face units per device px
      out[AO] = 0.5;
      if (T.dots) { out[PI_] = pitchFor(cssR, dpr); out[DOTS] = 1; snapDots(out, out[PI_]); }
      else {
        out[PI_] = 0; out[DOTS] = 0;
        out[EW] = Math.max(out[EW], 1.3 * mp); out[EH] = Math.max(out[EH], 0.85 * mp);
        out[MT] = Math.max(out[MT], 0.8 * mp); out[ET] = Math.max(out[ET], 0.8 * mp);
      }
      out[GW] = T.gw; out[GK] = T.gk * (cssR < 40 ? T.small : 1);
      if (W8) for (var r = 0; r < GN; r++) for (var c = 0; c < GN; c++) {
        var a = 2 * c / G - 1, b = 1 - 2 * r / G;
        var cv = cov(out, a, b, 0.09);
        W8[off + r * GN + c] = Math.min(255, (cv * 1.7 * 255 + 0.5) | 0);
      }
      return out;
    }

    /* ---- the shapes (the GLSL below is their twin) */
    function sdRB(px, py, bx, by, r) {
      var qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
      return Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    }
    function sdSeg(px, py, ax, ay, bx, by) {
      var pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay, h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
      return Math.sqrt((pax - bax * h) * (pax - bax * h) + (pay - bay * h) * (pay - bay * h));
    }
    function eyeFill(v, px, py, ux) {
      var hw = v[EW], hh = v[EH], r = Math.min(v[ER], 1) * Math.min(hw, hh);
      var d = sdRB(px, py, hw, hh, r);
      d = Math.max(d, py - hh * (1 - 2 * v[LT]));
      d = Math.max(d, -py - hh * (1 - 2 * v[LB]));
      if (v[CA] > 0) d = Math.max(d, -(Math.sqrt((ux - hw * 0.4) * (ux - hw * 0.4) + (py - hh * 0.45) * (py - hh * 0.45)) - v[CA]));
      return d;
    }
    function eyeArc(v, px, py) {
      var w = v[EW], h = v[EH] * v[AC], ao = v[AO], u = clamp(px, -w, w), y = h * (1 - u * u / (w * w)) - h * ao;
      if (Math.abs(px) > w) return Math.sqrt((Math.abs(px) - w) * (Math.abs(px) - w) + (py + h * ao) * (py + h * ao)) - v[ET];
      var s = v[DOTS] > 0.5 ? 0 : -2 * h * u / (w * w);
      return Math.abs(py - y) / Math.sqrt(1 + s * s) - v[ET];
    }
    function eyeX(v, px, py) { var w = v[EW] * 0.9, h = v[EH] * 0.9; return Math.min(sdSeg(px, py, -w, -h, w, h), sdSeg(px, py, -w, h, w, -h)) - v[ET]; }
    function mouthD(v, px, py) {
      // an open mouth: a superellipse (n 3) under the lip line -- a rounded D, not a drop
      var w = Math.max(v[MW], 1e-4), s = clamp(px / w, -1, 1), as = Math.abs(s), q = Math.pow(Math.max(0, 1 - as * as * as), 1 / 3);
      if (Math.abs(px) > w) return Math.sqrt((Math.abs(px) - w) * (Math.abs(px) - w) + py * py) - v[MT];
      var base = -v[MC] * (1 - s * s), sl = 2 * v[MC] * s / w, sg = s < 0 ? -1 : 1, dq = q > 1e-3 ? -sg * s * s / (w * q * q) : -sg * 1e3;
      var up = base + 0.55 * v[MH] * q + v[MT], lo = base - v[MH] * q - v[MT], mid = (up + lo) / 2, g;
      var gk = v[DOTS] > 0.5 ? 0 : 1;
      if (py >= mid) { g = gk * clamp(sl + 0.55 * v[MH] * dq, -20, 20); return (py - up) / Math.sqrt(1 + g * g); }
      g = gk * clamp(sl - v[MH] * dq, -20, 20); return (lo - py) / Math.sqrt(1 + g * g);
    }
    function cv(d, aa) { var x = 0.5 - d / aa; return x < 0 ? 0 : x > 1 ? 1 : x; }
    /** Coverage 0..1 of the face at (a, b) with an edge aa wide (face units). */
    function cov(v, a, b, aa) {
      var ex = a - v[OX], ey = b - v[EY] - v[OY], sx = ex < 0 ? -1 : 1, px = Math.abs(ex) - v[EX], ux = ex - sx * v[EX];
      var aw = v[AW], xw = v[XW], fw = Math.max(0, 1 - aw - xw), ce = 0;
      if (fw > 0.001) ce += fw * cv(eyeFill(v, px, ey, ux), aa);
      if (aw > 0.001) ce += aw * cv(eyeArc(v, px, ey), aa);
      if (xw > 0.001) ce += xw * cv(eyeX(v, px, ey), aa);
      var cm = v[MV] > 0.001 ? v[MV] * cv(mouthD(v, a - v[OX] * 0.35, b - v[MY] - v[OY] * 0.3), aa) : 0;
      return Math.min(1, Math.max(ce, cm));
    }
    function covAt(v, a, b, aa) {
      if (v[DOTS] < 0.5) return cov(v, a, b, aa);
      var p = v[PI_], cx = Math.floor(a / p + 0.5) * p, cy = Math.floor(b / p + 0.5) * p;
      var lit = cov(v, cx, cy, p * 0.2), dd = Math.sqrt((a - cx) * (a - cx) + (b - cy) * (b - cy)) - p * (p > 0.12 ? 0.46 : 0.4);
      return lit * cv(dd, aa);
    }

    /*
     * ---- GL: per head, two tight boxes of the front surface -- the eyes' band and the mouth -- drawn from one unit
     * grid that the vertex shader places (u_box, in face coords) and lifts onto the superellipsoid (u_p), so only the
     * pixels near a feature run the face's shader (one patch over the whole face cost a frame step on a CPU rasteriser)
     */
    var GRID = null;
    function patch() {
      if (GRID) return GRID;
      var NU = 16, NV = 8, vs = [], ix = [];
      for (var j = 0; j <= NV; j++) for (var i = 0; i <= NU; i++) vs.push(i / NU, j / NV);
      for (j = 0; j < NV; j++) for (i = 0; i < NU; i++) { var q = j * (NU + 1) + i; ix.push(q, q + 1, q + NU + 1, q + 1, q + NU + 2, q + NU + 1); }
      return (GRID = { v: new Float32Array(vs), i: new Uint16Array(ix) });
    }
    var VS = [
      "#version 300 es",
      "precision highp float;",
      "layout(location=0) in vec2 a_g;",
      "uniform vec2 u_res,u_c; uniform vec4 u_box; uniform float u_r,u_fs,u_sc,u_yaw,u_tilt,u_p;",
      "out vec2 v_uv;",
      "void main(){ vec2 ab=mix(u_box.xy,u_box.zw,a_g); float k=pow(pow(abs(ab.x),u_p)+pow(abs(ab.y),u_p)+1.0,-1.0/u_p);",
      " vec3 p=vec3(ab.x*k,ab.y*k*0.98,k*1.003); float cy=cos(u_yaw),sy=sin(u_yaw),ct=cos(u_tilt),st=sin(u_tilt);",
      " float x1=p.x*cy+p.z*sy, z1=-p.x*sy+p.z*cy; float y2=p.y*ct-z1*st;",
      " vec2 px=(u_c+vec2(x1,y2)*u_r*u_sc)*u_fs; v_uv=ab; gl_Position=vec4(px/u_res*2.0-1.0,0.0,1.0); }",
    ].join("\n");
    var FS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 v_uv; uniform vec4 u_f[7]; uniform vec3 u_st; uniform float u_lit,u_alpha,u_gl; out vec4 o;",
      "#define EX u_f[0].x", "#define EY u_f[0].y", "#define EW u_f[0].z", "#define EH u_f[0].w",
      "#define ER u_f[1].x", "#define LT u_f[1].y", "#define LB u_f[1].z", "#define CA u_f[1].w",
      "#define AW u_f[2].x", "#define AC u_f[2].y", "#define XW u_f[2].z", "#define ET u_f[2].w",
      "#define MW u_f[3].x", "#define MY u_f[3].y", "#define MH u_f[3].z", "#define MC u_f[3].w",
      "#define MT u_f[4].x", "#define MV u_f[4].y", "#define OX u_f[4].z", "#define OY u_f[4].w",
      "#define PIT u_f[5].x", "#define GWD u_f[5].y", "#define DOTS u_f[5].z", "#define AO u_f[6].x",
      "float sdRB(vec2 p,vec2 b,float r){ vec2 q=abs(p)-b+r; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r; }",
      "float sdSeg(vec2 p,vec2 a,vec2 b){ vec2 pa=p-a,ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*h); }",
      "float eyeFill(vec2 p,float ux){ float r=min(ER,1.0)*min(EW,EH); float d=sdRB(p,vec2(EW,EH),r);",
      " d=max(d,p.y-EH*(1.0-2.0*LT)); d=max(d,-p.y-EH*(1.0-2.0*LB));",
      " if(CA>0.0) d=max(d,-(length(vec2(ux-EW*0.4,p.y-EH*0.45))-CA)); return d; }",
      "float eyeArc(vec2 p){ float w=EW,h=EH*AC; float u=clamp(p.x,-w,w); float y=h*(1.0-u*u/(w*w))-h*AO;",
      " if(abs(p.x)>w) return length(vec2(abs(p.x)-w,p.y+h*AO))-ET; float s=DOTS>0.5?0.0:-2.0*h*u/(w*w); return abs(p.y-y)/sqrt(1.0+s*s)-ET; }",
      "float eyeX(vec2 p){ float w=EW*0.9,h=EH*0.9; return min(sdSeg(p,vec2(-w,-h),vec2(w,h)),sdSeg(p,vec2(-w,h),vec2(w,-h)))-ET; }",
      "float mouthD(vec2 p){ float w=max(MW,1e-4); float s=clamp(p.x/w,-1.0,1.0); float as_=abs(s); float q=pow(max(0.0,1.0-as_*as_*as_),1.0/3.0);",
      " if(abs(p.x)>w) return length(vec2(abs(p.x)-w,p.y))-MT;",
      " float base=-MC*(1.0-s*s); float sl=2.0*MC*s/w; float sg=s<0.0?-1.0:1.0; float dq=q>1e-3?-sg*s*s/(w*q*q):-sg*1e3;",
      " float up=base+0.55*MH*q+MT, lo=base-MH*q-MT, mid=(up+lo)*0.5;",
      " float gk=DOTS>0.5?0.0:1.0;",
      " if(p.y>=mid){ float g=gk*clamp(sl+0.55*MH*dq,-20.0,20.0); return (p.y-up)/sqrt(1.0+g*g); }",
      " float g=gk*clamp(sl-MH*dq,-20.0,20.0); return (lo-p.y)/sqrt(1.0+g*g); }",
      "float cvv(float d,float aa){ return clamp(0.5-d/aa,0.0,1.0); }",
      "float cov(vec2 q,float aa){ vec2 e=vec2(q.x-OX,q.y-EY-OY); float sx=e.x<0.0?-1.0:1.0; vec2 p=vec2(abs(e.x)-EX,e.y); float ux=e.x-sx*EX;",
      " float fw=max(0.0,1.0-AW-XW); float ce=0.0;",
      " if(fw>0.001) ce+=fw*cvv(eyeFill(p,ux),aa); if(AW>0.001) ce+=AW*cvv(eyeArc(p),aa); if(XW>0.001) ce+=XW*cvv(eyeX(p),aa);",
      " float cm=MV>0.001?MV*cvv(mouthD(vec2(q.x-OX*0.35,q.y-MY-OY*0.3)),aa):0.0; return min(1.0,max(ce,cm)); }",
      "void main(){ vec2 q=v_uv; float fw=max(fwidth(q.x),fwidth(q.y)); float c;",
      " if(u_gl>0.5) c=cov(q,GWD)*0.9;",
      " else if(DOTS>0.5){ vec2 ce=floor(q/PIT+0.5)*PIT; float lit=cov(ce,PIT*0.2); float dd=length(q-ce)-PIT*(PIT>0.12?0.46:0.4); c=lit*cvv(dd,fw*1.1); }",
      " else c=cov(q,fw*1.15);",
      " float a=clamp(c*u_lit,0.0,1.0)*u_alpha; if(a<0.003) discard; o=vec4(u_st*a,a); }",
    ].join("\n");
    /**
     * One head's face on GL (P: the program, g: the grid {vao, n}, h: the pool head, v: its vector, p: the head's
     * superellipsoid power): the eyes' box, then the mouth's, abutting (never overlapping: nothing is drawn twice).
     */
    function drawGL(gl, P, g, h, v, resW, resH, fs, dpr, cssH, glowPass, light, p) {
      var u = P.u, fa = h.alpha * (h.form < 1 ? h.form * h.form : 1) * (1 - h.dis);
      if (fa < 0.01) return;
      var m = (glowPass ? v[GW] * 1.3 : 0.03 + 3 / Math.max(1, h.r * dpr)) + (v[DOTS] > 0.5 ? v[PI_] : 0);
      var eT = Math.min(0.95, v[EY] + v[OY] + v[EH] + v[ET] + m), eB = Math.max(-0.95, v[EY] + v[OY] - v[EH] - v[ET] - m);
      var eW = Math.min(0.95, v[EX] + v[EW] + v[ET] + m), mx = v[OX] * 0.35, my = v[MY] + v[OY] * 0.3, ac = Math.abs(v[MC]);
      var mT = Math.min(eB, my + ac + 0.55 * v[MH] + v[MT] + m), mB = Math.max(-0.95, my - ac - v[MH] - v[MT] - m), mW = v[MW] + v[MT] + m;
      gl.uniform2f(u.u_res, resW, resH); gl.uniform2f(u.u_c, h.cx * dpr, (cssH - h.cy) * dpr);
      gl.uniform1f(u.u_r, h.r * dpr); gl.uniform1f(u.u_fs, fs); gl.uniform1f(u.u_sc, h.sc); gl.uniform1f(u.u_yaw, h.yaw); gl.uniform1f(u.u_tilt, h.tilt);
      gl.uniform4fv(u["u_f[0]"], v);
      gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
      gl.uniform1f(u.u_lit, glowPass ? h.lit * h.glowK * v[GK] * (light ? 0.28 : 0.55) : h.lit);
      gl.uniform1f(u.u_alpha, fa); gl.uniform1f(u.u_gl, glowPass ? 1 : 0); gl.uniform1f(u.u_p, p);
      gl.bindVertexArray(g.vao);
      gl.uniform4f(u.u_box, Math.max(-0.95, v[OX] - eW), eB, Math.min(0.95, v[OX] + eW), eT); gl.drawElements(gl.TRIANGLES, g.n, gl.UNSIGNED_SHORT, 0);
      if (v[MV] > 0.001 && mT > mB) { gl.uniform4f(u.u_box, Math.max(-0.95, mx - mW), mB, Math.min(0.95, mx + mW), mT); gl.drawElements(gl.TRIANGLES, g.n, gl.UNSIGNED_SHORT, 0); }
    }

    /*
     * ---- 2D (the fallback and the Settings thumbnails): the same shapes as vector paths, every vertex through the
     * head's exact projection, so canvas anti-aliases them; the dots are circles at the lit grid centres; the glow is
     * the fill's shadow. No allocation per call: the projection's state and the scratch buffers are module-level.
     * (A per-pixel twin was tried first: correct, but its putImageData uploads stalled the compositor once six
     * session heads were on screen.)
     */
    var PT = new Float64Array(2), PJ = { p: 4, cx: 0, cy: 0, R: 1, cyw: 1, syw: 0, ct: 1, stt: 0 }, G2 = null;
    var CORNER = [1, 1, 0, -1, 1, PI / 2, -1, -1, PI, 1, -1, 1.5 * PI], RECTS = new Float64Array(12), PART = new Float64Array(3 * 256);
    function proj(a, b) {
      var p = PJ.p, k = Math.pow(Math.pow(Math.abs(a), p) + Math.pow(Math.abs(b), p) + 1, -1 / p), x = a * k, y = b * k * 0.98, z = k;
      var x1 = x * PJ.cyw + z * PJ.syw, z1 = -x * PJ.syw + z * PJ.cyw, y2 = y * PJ.ct - z1 * PJ.stt;
      PT[0] = PJ.cx + x1 * PJ.R; PT[1] = PJ.cy - y2 * PJ.R;
    }
    function to(a, b, first) { proj(a, b); if (first) G2.moveTo(PT[0], PT[1]); else G2.lineTo(PT[0], PT[1]); }
    function draw2d(g, o, cyw, syw, ct, stt, R, fade) {
      var v = o.fv, dpr = o.dpr || 1, i, n;
      var lit = Math.min(1, o.lit) * fade, gk = v[GK] * (o.light ? 0.45 : 0.9);
      if (lit < 0.01) return;
      PJ.p = o.geo.cfg.p; PJ.cx = o.cx; PJ.cy = o.cy; PJ.R = R; PJ.cyw = cyw; PJ.syw = syw; PJ.ct = ct; PJ.stt = stt; G2 = g;
      var col = rgba(o.st, 1);
      g.save();
      g.fillStyle = col; g.strokeStyle = col; g.lineCap = "round"; g.lineJoin = "round";
      if (gk > 0.01) { g.shadowColor = rgba(o.st, Math.min(1, gk)); g.shadowBlur = Math.max(2, R * v[GW] * 0.5) * dpr; }
      var oy = v[EY] + v[OY], fw = Math.max(0, 1 - v[AW] - v[XW]);
      if (v[DOTS] > 0.5) {
        // the dot grid: every lit centre inside the features' rectangles, full dots in one path, partial ones alone
        var pp = v[PI_], rad = pp * (pp > 0.12 ? 0.46 : 0.4) * R * 0.97, m = pp, ac = Math.abs(v[MC]), np = 0, nr = 2;
        var ew = v[EW] + v[ET] + m, eh = v[EH] + v[ET] + m, mw = v[MW] + v[MT] + m, mx = v[OX] * 0.35, my = v[MY] + v[OY] * 0.3;
        RECTS[0] = v[OX] + v[EX] - ew; RECTS[1] = v[OX] + v[EX] + ew; RECTS[2] = oy - eh; RECTS[3] = oy + eh;
        RECTS[4] = v[OX] - v[EX] - ew; RECTS[5] = v[OX] - v[EX] + ew; RECTS[6] = oy - eh; RECTS[7] = oy + eh;
        if (v[MV] > 0.001) { nr = 3; RECTS[8] = mx - mw; RECTS[9] = mx + mw; RECTS[10] = my - ac - v[MH] - v[MT] - m; RECTS[11] = my + ac + 0.55 * v[MH] + v[MT] + m; }
        g.globalAlpha = lit; g.beginPath();
        for (var ri = 0; ri < nr; ri++) {
          var r0 = ri * 4;
          for (var gy = Math.ceil(RECTS[r0 + 2] / pp); gy * pp <= RECTS[r0 + 3]; gy++) for (var gx = Math.ceil(RECTS[r0] / pp); gx * pp <= RECTS[r0 + 1]; gx++) {
            // a dot two rectangles share is drawn by the first only
            var dup = false;
            for (var rj = 0; rj < ri; rj++) { var q0 = rj * 4; if (gx * pp >= RECTS[q0] && gx * pp <= RECTS[q0 + 1] && gy * pp >= RECTS[q0 + 2] && gy * pp <= RECTS[q0 + 3]) dup = true; }
            if (dup) continue;
            var lv = cov(v, gx * pp, gy * pp, pp * 0.2);
            if (lv < 0.02) continue;
            proj(gx * pp, gy * pp);
            if (lv > 0.98) { g.moveTo(PT[0] + rad, PT[1]); g.arc(PT[0], PT[1], rad, 0, 2 * PI); }
            else if (np < 256) { PART[np * 3] = PT[0]; PART[np * 3 + 1] = PT[1]; PART[np * 3 + 2] = lv; np++; }
          }
        }
        g.fill();
        for (i = 0; i < np; i++) { g.globalAlpha = lit * PART[i * 3 + 2]; g.beginPath(); g.arc(PART[i * 3], PART[i * 3 + 1], rad, 0, 2 * PI); g.fill(); }
        g.restore();
        return;
      }
      for (var side = -1; side <= 1; side += 2) {
        var cx = v[OX] + side * v[EX], hw = v[EW], hh = v[EH];
        if (fw > 0.001) { // a rounded rectangle, cut by the lids; a catchlight as an even-odd hole
          var r = Math.min(v[ER], 1) * Math.min(hw, hh), yT = hh * (1 - 2 * v[LT]), yB = -hh * (1 - 2 * v[LB]), first = true;
          g.globalAlpha = lit * fw; g.beginPath();
          for (var qc = 0; qc < 4; qc++) for (i = 0; i <= 8; i++) {
            var an = CORNER[qc * 3 + 2] + i / 8 * PI / 2, px = CORNER[qc * 3] * (hw - r) + Math.cos(an) * r, py = CORNER[qc * 3 + 1] * (hh - r) + Math.sin(an) * r;
            to(cx + px, oy + Math.max(yB, Math.min(yT, py)), first); first = false;
          }
          g.closePath();
          if (v[CA] > 0) { for (i = 0; i <= 16; i++) { var ca = i / 16 * 2 * PI; to(cx + hw * 0.4 + Math.cos(ca) * v[CA], oy + hh * 0.45 + Math.sin(ca) * v[CA], i === 0); } g.closePath(); }
          g.fill("evenodd");
        }
        g.lineWidth = 2 * v[ET] * R;
        if (v[AW] > 0.001) { // an arc
          var h = hh * v[AC]; g.globalAlpha = lit * v[AW]; g.beginPath(); n = 14;
          for (i = 0; i <= n; i++) { var u = -hw + 2 * hw * i / n; to(cx + u, oy + h * (1 - u * u / (hw * hw)) - h * v[AO], i === 0); }
          g.stroke();
        }
        if (v[XW] > 0.001) { // an x
          var xw = hw * 0.9, xh = hh * 0.9; g.globalAlpha = lit * v[XW]; g.beginPath();
          to(cx - xw, oy - xh, true); to(cx + xw, oy + xh, false); to(cx - xw, oy + xh, true); to(cx + xw, oy - xh, false); g.stroke();
        }
      }
      if (v[MV] > 0.001) { // the mouth: the open shape's outline, filled and stroked MT wide (its rounded ends)
        var mw2 = Math.max(v[MW], 1e-4), mx2 = v[OX] * 0.35, my2 = v[MY] + v[OY] * 0.3; n = 24;
        g.globalAlpha = lit * v[MV]; g.lineWidth = 2 * v[MT] * R; g.beginPath();
        for (i = 0; i <= n; i++) { var s = -1 + 2 * i / n, qq = Math.pow(Math.max(0, 1 - Math.abs(s * s * s)), 1 / 3); to(mx2 + s * mw2, my2 - v[MC] * (1 - s * s) + 0.55 * v[MH] * qq, i === 0); }
        for (i = n; i >= 0; i--) { var s2 = -1 + 2 * i / n, q2 = Math.pow(Math.max(0, 1 - Math.abs(s2 * s2 * s2)), 1 / 3); to(mx2 + s2 * mw2, my2 - v[MC] * (1 - s2 * s2) - v[MH] * q2, false); }
        g.closePath(); if (v[MH] > 0.002) g.fill(); g.stroke();
      }
      g.restore();
      G2 = null;
    }

    return { N: N, STY: STY, NAMES: NAMES, norm: norm, vec: vecFor, cov: cov, covAt: covAt, patch: patch, VS: VS, FS: FS, drawGL: drawGL, draw2d: draw2d, pitchFor: pitchFor };
  })();


  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")"; }
  var P2 = null; // projected positions, reused
  /**
   * One head on a 2D context (CSS px, y down): o = { geo, cx, cy, r, yaw, tilt, sc, wire, st, wa, lit, alpha, w (Uint8Array),
   * off, light, rimA, rimB, rimL, rimK, stK, form, dis, homeX, homeY, shimX, shimA, dpr, fv (the face vector, FACE.vec) }.
   */
  function draw2dHead(g, o) {
    var geo = o.geo, V = geo.v, n = geo.n;
    if (!P2 || P2.length < n * 3) P2 = new Float32Array(Math.max(n * 3, 16384));
    var cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw), ct = Math.cos(o.tilt), stt = Math.sin(o.tilt), R = o.r * o.sc;
    for (var i = 0; i < n; i++) {
      var b = i * 7, x = V[b], y = V[b + 1], z = V[b + 2];
      var x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y2 = y * ct - z1 * stt, z2 = z1 * ct + y * stt;
      var X = o.cx + x1 * R, Y = o.cy - y2 * R;
      if (o.form < 1 || o.dis > 0) {
        var rn = V[b + 5], p, u;
        if (o.form < 1) { p = Math.max(0, Math.min(1, (o.form - rn * 0.45) / 0.55)); p = p * p * (3 - 2 * p); u = 1 - p; X = u * u * o.homeX + 2 * u * p * (o.homeX + X) / 2 + p * p * X; Y = u * u * o.homeY + 2 * u * p * (o.homeY + Y) / 2 + p * p * Y; }
        if (o.dis > 0) { p = Math.max(0, Math.min(1, (o.dis - rn * 0.4) / 0.6)); p = p * p * (3 - 2 * p); u = 1 - p; X = u * u * X + 2 * u * p * (o.homeX + X) / 2 + p * p * o.homeX; Y = u * u * Y + 2 * u * p * (o.homeY + Y) / 2 + p * p * o.homeY; }
      }
      P2[i * 3] = X; P2[i * 3 + 1] = Y; P2[i * 3 + 2] = z2;
    }
    var fade = o.alpha * (o.form < 1 ? 0.4 + 0.6 * o.form : 1) * (o.dis > 0 ? 1 - o.dis * 0.85 : 1);
    var sst = function (a, b, x) { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
    var lf = sst(0.95, 1, o.form) * (1 - sst(0, 0.1, o.dis)); // a head forming or dissolving is dots only: its lines would stretch
    var W8 = o.w, off = o.off;
    function wAt(f) { return f < 0 ? 0 : W8[off + f] / 255; }
    // glow behind
    if (o.rimK > 0.001) {
      var gr = g.createRadialGradient(o.cx, o.cy, o.r * 0.2, o.cx, o.cy, o.r * 1.6);
      var rc = o.light ? o.rimL : [(o.rimA[0] + o.rimB[0]) / 2, (o.rimA[1] + o.rimB[1]) / 2, (o.rimA[2] + o.rimB[2]) / 2];
      gr.addColorStop(0, rgba(rc, o.rimK * fade)); gr.addColorStop(0.55, rgba(rc, o.rimK * 0.6 * fade)); gr.addColorStop(1, rgba(rc, 0));
      g.fillStyle = gr; g.fillRect(o.cx - o.r * 1.7, o.cy - o.r * 1.7, o.r * 3.4, o.r * 3.4);
    }
    if (o.stK > 0.001) {
      var sy0 = o.cy + o.r * 0.12, gs = g.createRadialGradient(o.cx, sy0, 0, o.cx, sy0, o.r * 1.05);
      gs.addColorStop(0, rgba(o.st, o.stK * fade)); gs.addColorStop(1, rgba(o.st, 0));
      g.fillStyle = gs; g.fillRect(o.cx - o.r * 1.1, sy0 - o.r * 1.1, o.r * 2.2, o.r * 2.2);
    }
    // the wireframe, in five depth buckets (one stroke each)
    var L = geo.lines;
    g.lineWidth = o.dpr > 1.4 ? 0.6 : 0.8;
    for (var bk = 0; bk < 5; bk++) {
      g.beginPath();
      var any = false;
      for (i = 0; i < L.length; i += 2) {
        var a0 = L[i], b0 = L[i + 1], za = P2[a0 * 3 + 2], zb = P2[b0 * 3 + 2], ka = V[a0 * 7 + 3];
        if (ka === 2 || ka === 6) continue;
        if (ka === 0 && (za < 0 || zb < 0)) continue;
        var d = Math.max(0, Math.min(1, ((za + zb) / 2 + 1) / 2)), bb = Math.min(4, (d * 5) | 0);
        if (bb !== bk) continue;
        g.moveTo(P2[a0 * 3], P2[a0 * 3 + 1]); g.lineTo(P2[b0 * 3], P2[b0 * 3 + 1]); any = true;
      }
      if (!any) continue;
      var dm = (bk + 0.5) / 5;
      g.strokeStyle = rgba(o.wire, (0.05 + 0.28 * dm * dm) * o.wa * 1.25 * fade * lf);
      g.stroke();
    }
    // rods and lit accessory lines
    for (i = 0; i < L.length; i += 2) {
      var k2 = V[L[i] * 7 + 3];
      if (k2 !== 2 && k2 !== 6) continue;
      g.strokeStyle = k2 === 2 ? rgba(o.st, 0.9 * o.lit * fade * lf) : rgba(o.wire, 0.55 * o.wa * fade * lf);
      g.beginPath(); g.moveTo(P2[L[i] * 3], P2[L[i] * 3 + 1]); g.lineTo(P2[L[i + 1] * 3], P2[L[i + 1] * 3 + 1]); g.stroke();
    }
    // nodes
    var Pt = geo.pts, ps = Math.max(0.55, Math.min(1.5, o.r / 120));
    g.fillStyle = rgba(o.wire, 1);
    for (i = 0; i < Pt.length; i++) {
      var vi = Pt[i], kk = V[vi * 7 + 3], z = P2[vi * 3 + 2];
      if ((kk === 0 || kk === 5) && z < 0) continue;
      if (kk === 5) continue;
      var dd = Math.max(0, Math.min(1, (z + 1) / 2)), w = wAt(V[vi * 7 + 4]);
      if (kk === 3 || kk === 4) {
        var jr = 3.6 * ps;
        g.globalAlpha = 1; g.fillStyle = kk === 4 ? rgba(o.st, o.lit * fade) : rgba(o.wire, 0.8 * fade);
        g.beginPath(); g.arc(P2[vi * 3], P2[vi * 3 + 1], jr, 0, 7); g.fill();
        if (kk === 3) { g.fillStyle = "rgba(255,255,255," + (0.85 * fade).toFixed(3) + ")"; g.beginPath(); g.arc(P2[vi * 3], P2[vi * 3 + 1], jr * 0.62, 0, 7); g.fill(); }
        g.fillStyle = rgba(o.wire, 1);
        continue;
      }
      var a = (0.08 + 0.35 * dd * dd) * o.wa * 1.2 * (1 - w) * fade;
      if (kk === 2) { g.fillStyle = rgba(o.st, 0.6 * o.lit * fade); a = 1; }
      if (kk === 0 && o.ind) { // look and speak: the front face's edge nodes (the shader's twin)
        var vx = V[vi * 7], vy = V[vi * 7 + 1], ee = Math.max(Math.abs(vx), Math.abs(vy) / 0.98);
        var rim = V[vi * 7 + 2] >= 0.25 ? sst(0.7, 0.86, ee) : 0;
        if (rim > 0.01) {
          var ff = ((Math.atan2(vx, vy) / 6.2831853) % 1 + 1) % 1, on = Math.max(0, Math.min(1, (o.ind.arm - ff) * 40)), ik = rim * on * o.ind.k;
          if (ik > 0.02) { g.globalAlpha = Math.min(1, ik); g.fillStyle = rgba(o.st, 1); var isz = (0.6 + 1.7 * dd) * ps * (1 + 1.2 * ik) * 1.4; g.fillRect(P2[vi * 3] - isz / 2, P2[vi * 3 + 1] - isz / 2, isz, isz); g.fillStyle = rgba(o.wire, 1); continue; }
        }
      }
      if (a < 0.01) continue;
      var sh = o.shimA > 0 ? o.shimA * Math.exp(-Math.pow((V[vi * 7] - o.shimX) / 0.22, 2)) : 0;
      g.globalAlpha = Math.min(1, a + sh * 0.6);
      var sz = (0.6 + 1.7 * dd) * ps * (1 + sh * 0.7);
      g.fillRect(P2[vi * 3] - sz / 2, P2[vi * 3 + 1] - sz / 2, sz, sz);
      if (kk === 2) g.fillStyle = rgba(o.wire, 1);
    }
    g.globalAlpha = 1;
    // the face: its vector layer through the same projection (FACE.draw2d)
    if (o.fv) FACE.draw2d(g, o, cyw, syw, ct, stt, R, fade);
  }

  /* ------------------------------------------------------------ the core */
  function synthAmp(t) {
    var phrase = Math.sin(t * 0.9) * 0.5 + 0.5 > 0.18 ? 1 : 0.1, syl = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2));
    return Math.min(1, (0.18 + 0.75 * syl + 0.12 * Math.sin(t * 17.0)) * phrase);
  }
  function synthListen(t) {
    var phrase = Math.sin(t * 0.7 + 2.0) * 0.5 + 0.5 > 0.3 ? 1 : 0.08, syl = Math.abs(Math.sin(t * 5.9 + 0.4) * Math.sin(t * 2.3));
    return Math.min(1, (0.1 + 0.8 * syl) * phrase);
  }
  function beat(t) { var b = (t / 1.8) % 1; return Math.exp(-Math.pow((b - 0.05) / 0.05, 2)) + 0.7 * Math.exp(-Math.pow((b - 0.25) / 0.055, 2)); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /*
   * The face style (2026-10-22): the viewer's choice (users.joya_bot_face), written by the server as data-bot-face on
   * #cc, the dock and Settings; read here once, then JoyaBot.setFace(style) switches every live core on the page (the
   * Command Center, the dock, the companion, the page flight, the previews). A change saved in Settings in another tab
   * (or the page in the desktop app's frame) arrives as a storage event ("joya-bot", { face }) and is taken the same
   * way. A core created with opts.face keeps its own (core.setFace).
   */
  var pageFace = null, LIVE = [];
  function faceNow() {
    if (pageFace) return pageFace;
    var el = typeof document !== "undefined" && document.querySelector ? document.querySelector("[data-bot-face]") : null;
    return FACE.norm(el ? el.getAttribute("data-bot-face") : "");
  }
  function setPageFace(f) {
    pageFace = FACE.norm(f);
    if (typeof document !== "undefined" && document.querySelectorAll) {
      var els = document.querySelectorAll("[data-bot-face]");
      for (var i = 0; i < els.length; i++) els[i].setAttribute("data-bot-face", pageFace);
    }
    for (var j = 0; j < LIVE.length; j++) LIVE[j]();
    return pageFace;
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", function (e) {
      if (e.key !== "joya-bot" || !e.newValue) return;
      var b = null;
      try { b = JSON.parse(e.newValue); } catch (x) { b = null; }
      if (b && typeof b.face === "string") setPageFace(b.face);
    });
  }

  function create(canvas, opts) {
    opts = opts || {};
    var GLOW = opts.backdrop !== "none";
    var DESK = !!opts.desk; // the desktop app: backplates + a stronger wireframe (see the header)
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var S = {
      concept: "E", state: "idle", amp: 0, ampSlow: 0, t: 0, c: [0, 0], R: 200, light: 0, lightT: 0, dpr: 1, cssW: 0, cssH: 0,
      head: HEADS[opts.head] ? opts.head : "cap", offline: false, bead: 0, arrive: 0,
      desk: DESK, running: false, wanted: false, still: !!(reduceMq && reduceMq.matches), frames: [], gl: false, lowRes: false,
      // expressive (2026-10-20): the mouth's viseme mix, the pointer, a glance, dozing, a reaction
      vis: { closed: 1, open: 0, wide: 0, round: 0 }, ptr: [0, 0], ptrOn: false, near: false, lookK: 0,
      headCheck: 0, headEdges: -1, testNoHead: false, // the head self-check (checkHead); testNoHead: tests only, as a GPU that skips the head
      gzUntil: 0, gzAt: null, doze: 0, dozeT: 0, dozeChk: 0, actAt: 0, rk: "", rt: 0, rd: 0,
      // eye contact (2026-10-20, joya-presence-bind.js): the camera's presence state and where the person is
      presence: null, contact: null, lookUpUntil: 0,
      // look and speak (2026-10-21, core.indicate): { phase, arm0, armT, armS, k } or null
      ind: null,
      // the face style: its own (opts.face) or the page's (faceNow), kept current by setPageFace
      faceOwn: opts.face ? FACE.norm(opts.face) : null, face: "smooth",
    };
    S.face = S.faceOwn || faceNow();
    var now = opts.now || function () { return Date.now(); };
    var hourOf = opts.hour || function () { return new Date().getHours(); };
    var specFn = opts.spec || null; // () -> { bins: Uint8Array (getByteFrequencyData), hz: Hz per bin } | null
    S.actAt = now();
    var VT = { closed: 1, open: 0, wide: 0, round: 0 }; // this frame's viseme target (reused)
    var ZP = [0, 0, 0, 0];
    var W = {};
    KEYS.forEach(function (k) { W[k] = 0; });
    var colors = opts.colors || null, PAL = palettes(colors), pal = { wire: [0, 0, 0], rim: [[0, 0, 0], [0, 0, 0]], rimL: [0, 0, 0] };
    var ampFn = opts.amp || null, destFn = opts.dest || null, onFrame = opts.onFrame || null, lastSize = null;
    var gl = null, ctx = null, raf = 0, last = 0;
    var progF = null, fvGrid = null, progW = null, progQ = null, progC = null, progS = null, progP = null, progZ = null, emptyVao = null, wtTex = null, fbo = null, fboTex = null, fboW = 0, fboH = 0, maxPt = 64;
    var W8 = new Uint8Array(NF * ROWS);
    var coreAnim = new Anim(11), kidAnims = {}, kidSeen = 0;
    var geos = {}; // detail -> { geo, vao, vbo, ibL, ibP }

    /* ---------------- GL setup */
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile");
      return s;
    }
    function prog(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) { var a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
      return { p: p, u: u };
    }
    function initGL() {
      if (opts.force2d) return false;
      try {
        gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: !!opts.preserve });
        if (!gl) return false;
        progW = prog(WIRE_VS, WIRE_FS); progQ = prog(QUAD_VS, QUAD_FS); progC = prog(COMP_VS, COMP_FS); progS = prog(STREAM_VS, WIRE_FS); progP = prog(QUAD_VS, PLATE_FS); progZ = prog(ZZZ_VS, WIRE_FS); progF = prog(FACE.VS, FACE.FS);
        emptyVao = gl.createVertexArray();
        var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        maxPt = range && range[1] ? range[1] : 64;
        wtTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, wtTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, NF, ROWS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return true;
      } catch (e) {
        if (window.console) console.warn("[core E] WebGL2 unavailable, drawing in 2D:", e && e.message);
        gl = null;
        if (canvas.parentNode) { var fresh = canvas.cloneNode(false); canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; }
        return false;
      }
    }
    function geoFor(head, detail) {
      var key = head + ":" + detail;
      if (geos[key]) return geos[key];
      var geo = build(head, detail), o = { geo: geo };
      if (gl) {
        o.vao = gl.createVertexArray(); gl.bindVertexArray(o.vao);
        o.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.vbo); gl.bufferData(gl.ARRAY_BUFFER, geo.v, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
        o.ibL = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibL); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.lines, gl.STATIC_DRAW);
        o.ibP = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibP); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.pts, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
      }
      geos[key] = o;
      return o;
    }
    /** The face's unit grid (FACE.patch), placed per box by its vertex shader. */
    function fvGeo() {
      if (fvGrid) return fvGrid;
      var P = FACE.patch(), o = { vao: gl.createVertexArray(), n: P.i.length };
      gl.bindVertexArray(o.vao);
      o.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.vbo); gl.bufferData(gl.ARRAY_BUFFER, P.v, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      o.ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, P.i, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return (fvGrid = o);
    }
    function freeGeos() {
      if (gl) {
        Object.keys(geos).forEach(function (k) {
          var o = geos[k];
          [o.vbo, o.ibL, o.ibP].forEach(function (b) { if (b) gl.deleteBuffer(b); });
          if (o.vao) gl.deleteVertexArray(o.vao);
        });
        if (fvGrid) { gl.deleteBuffer(fvGrid.vbo); gl.deleteBuffer(fvGrid.ib); gl.deleteVertexArray(fvGrid.vao); }
      }
      geos = {}; fvGrid = null;
    }
    function ensureFbo() {
      var w = Math.max(1, Math.ceil(canvas.width / 4)), h = Math.max(1, Math.ceil(canvas.height / 4));
      if (fbo && w === fboW && h === fboH) return;
      if (fboTex) gl.deleteTexture(fboTex);
      if (!fbo) fbo = gl.createFramebuffer();
      fboTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fboW = w; fboH = h;
    }

    /* ---------------- per frame: the heads to draw (no allocation: a fixed pool) */
    var POOL = [];
    for (var pi = 0; pi < MAXK + 1; pi++) POOL.push({ cx: 0, cy: 0, r: 0, yaw: 0, tilt: 0, sc: 1, st: [0, 0, 0], wa: 1, lit: 1, alpha: 1, row: 0, form: 1, dis: 0, rimK: 0, stK: 0, shimX: 0, shimA: 0, detail: "hi", head: "cap", glowK: 1, cssR: 0 });
    var nHeads = 0;
    var FVEC = []; // one face vector per head row (FACE.vec), reused
    for (var fvi = 0; fvi < MAXK + 1; fvi++) FVEC.push(new Float32Array(FACE.N));
    var HOME = [0, 0];
    function mixPal() {
      var a = PAL.dark, b = PAL.light, k = S.light;
      ["ready", "listening", "thinking", "speaking", "needs", "error", "wire"].forEach(function (key) {
        if (!pal[key]) pal[key] = [0, 0, 0];
        for (var i = 0; i < 3; i++) pal[key][i] = a[key][i] + (b[key][i] - a[key][i]) * k;
      });
      for (var i = 0; i < 3; i++) { pal.rim[0][i] = a.rim[0][i]; pal.rim[1][i] = a.rim[1][i]; pal.rimL[i] = b.rimL[i]; }
      pal.wireK = a.wireK + (b.wireK - a.wireK) * k;
    }
    function detailFor(cssR) { return cssR >= 60 ? "hi" : "lo"; }
    function headR() { return S.R / S.dpr * 0.57; }
    /** Where the core's head is, in CSS px (y down). */
    function coreCss() { return [S.c[0] / S.dpr, S.cssH - S.c[1] / S.dpr + S.R / S.dpr * 0.12]; }
    function prepare(dt) {
      mixPal();
      nHeads = 0;
      var dpr = S.dpr, cc = coreCss(), rc = headR(), cfg = HEADS[S.head];
      var M = 1 - W.err; // offline: still
      var dz = S.doze, awake = 1 - dz;
      // the core: its state's face, unless a reaction or dozing shows over it
      var fo = pickFace(S.state, S.offline, S.rk, dz);
      // look and speak (core.indicate): the edge's strength, and the face -- wide eyes when it is ready to listen,
      // looking at you while a reply waits for you to look back
      var IND = S.ind;
      if (IND) {
        var ph = IND.phase;
        IND.arm = ph !== "arming" ? 1 : S.still || !IND.armS ? IND.arm0 : Math.min(1, IND.arm0 + (1 - IND.arm0) * (S.t - IND.armT) / IND.armS);
        IND.k = S.still ? { arming: 0.9, ready: 0.8, listening: 0.7, paused: 0.45 }[ph] :
          ph === "arming" ? 0.9 : ph === "ready" ? 0.62 + 0.3 * (0.5 + 0.5 * Math.sin(S.t * 2.4)) :
          ph === "listening" ? 0.45 + 0.55 * Math.min(1, S.amp * 1.7) : 0.22 + 0.3 * Math.max(0, Math.sin(S.t * 2.2));
        if (!S.offline && S.rk !== "grin" && S.rk !== "surprise" && dz < 0.3) {
          if (ph === "ready" && S.state === "idle") fo = { face: "listen", state: "ready" };
          else if (ph === "paused") fo = { face: "pupils", state: fo.state };
        }
      }
      var an = coreAnim;
      an.set(fo.face, fo.state);
      an.lid = S.rk === "surprise" ? 1 : 1 - 0.8 * sstep(0, 0.6, dz); // drowsy: the lids come down before the sleep face
      if (S.still) { an.fk = 1; an.ck = 1; } // still frames (reduced motion, hold still): the new face at once
      an.step(dt, S.still || S.offline || W.err > 0.5, S.state === "idle" && !S.offline && dz < 0.3);
      var dst = null, ddx = 0, ddy = 0;
      if (W.deleg > 0.02) {
        dst = destFn ? destFn() : null;
        if (dst) { ddx = clamp((dst[0] - cc[0]) / (rc * 3.5), -1, 1); ddy = clamp((dst[1] - cc[1]) / (rc * 3.5), -1, 1); }
      }
      // where the eyes go: a delegation's target, else a glance at a session (it needs you, it replied), else the pointer, else an idle glance
      var gzOn = !S.still && S.gzUntil > S.t, gp = null, follow = false, lx = 0, ly = 0;
      if (gzOn) { gp = typeof S.gzAt === "function" ? S.gzAt() : S.gzAt; if (!gp) gzOn = false; }
      if (gzOn) { lx = clamp((gp[0] - cc[0]) / (rc * 3), -1, 1); ly = clamp((gp[1] - cc[1]) / (rc * 3), -1, 1); }
      // eye contact: just sat down -> a look up; then the eyes meet the person's (their place, from the camera)
      else if (!S.still && dz < 0.5 && S.lookUpUntil > S.t) { follow = true; lx = S.contact ? S.contact.x * 0.5 : 0; ly = -1; }
      else if (!S.still && dz < 0.5 && S.contact) { follow = true; lx = S.contact.x; ly = S.contact.y; }
      else if (S.ptrOn && !S.still && dz < 0.5) { follow = true; lx = clamp((S.ptr[0] - cc[0]) / (rc * 3.2), -1, 1); ly = clamp((S.ptr[1] - cc[1]) / (rc * 3.2), -1, 1); }
      var gl_ = !S.still && !gzOn && !follow && an.glanceUntil > an.t ? 1 : 0; // a still frame never freezes mid-glance
      if (S.state === "delegating") { an.gxT = ddx * 2; an.gyT = ddy > 0.35 ? 1 : ddy < -0.35 ? -1 : 0; }
      else if (gzOn || follow) { an.gxT = lx * (gzOn || S.contact ? 2 : 1.5); an.gyT = ly > 0.4 ? 1 : ly < -0.4 ? -1 : 0; }
      else { an.gxT = gl_ ? an.glx : 0; an.gyT = gl_ ? an.gly : 0; }
      if (dz > 0.5) { an.gxT = 0; an.gyT = 0; }
      var back = !gzOn && !follow && an.gxT === 0 && an.gyT === 0;
      var ek = S.still ? 1 : 1 - Math.exp(-dt * (back ? 3 : 10)); // the pointer left: drift back, slowly
      // a target from a place that had no size yet (a session's spot, the pointer over a core of radius 0, a value carried
      // over in a flight) can be NaN; one NaN in the gaze stays for good and takes the whole head with it -- every point
      // of it turns with the gaze -- leaving only the glow (user screenshots 2026-10-25, after Settings round trips)
      if (!isFinite(an.gxT)) an.gxT = 0; if (!isFinite(an.gyT)) an.gyT = 0;
      an.gx += (an.gxT - an.gx) * ek; an.gy += (an.gyT - an.gy) * ek;
      if (!isFinite(an.gx)) an.gx = an.gxT; if (!isFinite(an.gy)) an.gy = an.gyT;
      if (S.still) an.gx = Math.round(an.gx); // a still frame: the eyes on whole nodes (a frozen in-between shift reads as a garbled face)
      S.lookK += ((gzOn || follow ? 1 : 0) - S.lookK) * (S.still ? 1 : 1 - Math.exp(-dt * 4));
      FACE.vec(S.face, an, rc, S.dpr, W.speak > 0.05 ? S.amp : 0, W.speak > 0.05 ? S.vis : null, FVEC[0], W8, 0);
      var h = POOL[nHeads++];
      var tt = S.t;
      h.head = S.head; h.detail = detailFor(rc); h.cssR = rc;
      // a reaction's motion: a hop (grin: two, waking: one), a start (surprise), a nod; never in a still frame
      var rp = S.rk && !S.still ? Math.min(1, S.rt / S.rd) : 0, bob = 0, nod = 0, pop = 0, shake = 0;
      if (rp) {
        if (S.rk === "grin") bob = Math.abs(Math.sin(rp * 2 * PI)) * (1 - rp) * 0.09;
        else if (S.rk === "wake") bob = Math.sin(rp * PI) * 0.06;
        else if (S.rk === "surprise") { bob = Math.sin(Math.min(1, rp * 2.5) * PI) * 0.05; pop = 0.04 * Math.sin(Math.min(1, rp * 2) * PI); }
        else if (S.rk === "nod") nod = 0.22 * Math.sin(rp * 4 * PI) * (1 - rp);
        else if (S.rk === "shake") shake = 0.3 * Math.sin(rp * 6 * PI) * (1 - rp);
      }
      h.cx = cc[0]; h.cy = cc[1] - bob * rc; h.r = rc;
      var lk = S.lookK * (1 - W.deleg);
      h.yaw = cfg.yaw * (1 - 0.5 * W.deleg) + M * awake * (0.15 * Math.sin(tt * 0.37 + 0.6) + 0.05 * gl_ * (an.glx || 0) / 1.6) + W.deleg * ddx * 0.7 + lk * 0.14 * an.gx + shake;
      h.tilt = (cfg.tilt || 0.1) + M * 0.03 * awake * Math.sin(tt * 0.29) + W.deleg * ddy * 0.35 + lk * 0.1 * an.gy + 0.12 * dz + nod;
      h.sc = 1 + M * (0.014 * awake * Math.sin(tt * 1.25) + 0.03 * dz * Math.sin(tt * 0.55)) + pop; // dozing: slow, deeper breaths
      var c = an.color(pal);
      h.st[0] = c[0]; h.st[1] = c[1]; h.st[2] = c[2];
      var bt = beat(tt);
      h.wa = pal.wireK * (S.light > 0.5 ? 1.1 : 1) * (DESK ? 1.6 : 1); h.alpha = 1;
      h.lit = (IND && IND.phase === "arming" ? 1 + 0.3 * IND.arm : 1) * (1 + 0.3 * W.listen * S.amp) * (1 + W.need * (0.3 * bt - 0.12)) * (1 - 0.15 * W.err) * (1 - 0.3 * dz);
      h.glowK = (1 + 0.8 * W.listen * S.amp + 0.25 * W.speak * S.amp) * (1 + W.need * (0.5 * bt - 0.1)) * (1 - 0.4 * dz);
      // the desktop: the backglow is for a dark page; over a wallpaper it would wash out the dark backplate (and the lines)
      h.rimK = GLOW ? ((1 - S.light) * 0.32 + S.light * 0.1) * (DESK ? 0.2 : 1) : 0;
      h.stK = GLOW ? ((1 - S.light) * 0.2 + S.light * 0.11) * h.glowK * (DESK ? 0.6 : 1) : 0;
      h.shimA = W.think * 0.9 * M; h.shimX = -1.6 + ((tt * 0.62) % 1) * 3.2;
      h.form = 1; h.dis = 0; h.row = 0;
      // the sessions
      var list = opts.kids ? opts.kids() : null;
      kidSeen++;
      if (list && list.length) {
        var n = Math.min(MAXK, list.length);
        for (var i = 0; i < n; i++) {
          var k = list[i], key = k.key != null ? String(k.key) : "k" + i;
          var ka = kidAnims[key] || (kidAnims[key] = new Anim(97 + i * 131 + key.length * 17));
          ka.seen = kidSeen;
          var sf = k.form < 0.6 ? { state: "ready", face: "base" } : sessState(k);
          ka.set(sf.face, sf.state);
          if (S.still) { ka.fk = 1; ka.ck = 1; } // still frames: the new face at once
          ka.step(dt, S.still, k.st === "idle");
          var kr = k.r * 0.86;
          var dx = clamp((cc[0] - k.x) / (rc * 4), -1, 1), dy = clamp((cc[1] - k.y) / (rc * 4), -1, 1);
          // the pointer close by: that session looks at it
          var pdx = S.ptr[0] - k.x, pdy = S.ptr[1] - k.y, kp = S.ptrOn && !S.still && Math.abs(pdx) < kr * 3 && Math.abs(pdy) < kr * 3;
          ka.gxT = kp ? clamp(pdx / (kr * 2.2), -1, 1) * 1.6 : !S.still && ka.glanceUntil > ka.t ? ka.glx : dx * 1.2; ka.gyT = 0;
          if (!isFinite(ka.gxT)) ka.gxT = 0;
          ka.gx += (ka.gxT - ka.gx) * ek; ka.gy = 0;
          if (!isFinite(ka.gx)) ka.gx = ka.gxT;
          if (S.still) ka.gx = Math.round(ka.gx);
          FACE.vec(S.face, ka, kr, S.dpr, sf.state === "speaking" ? 0.35 + 0.55 * synthAmp(ka.t + ka.ph) : 0, null, FVEC[i + 1], W8, (i + 1) * NF);
          var q = POOL[nHeads++];
          q.head = k.head && HEADS[k.head] ? k.head : S.head; // its role's accessory (cc-logic botHeadFor), else the core's
          q.detail = "lo"; q.cssR = kr; q.row = i + 1;
          q.cx = k.x; q.cy = k.y + k.r * 0.06; q.r = kr;
          q.yaw = 0.45 * dx + (S.still ? 0 : 0.1 * Math.sin(ka.t * 0.4 + ka.ph));
          q.tilt = 0.1 + 0.2 * dy;
          q.sc = 1 + (S.still ? 0 : 0.012 * Math.sin(ka.t * 1.3 + ka.ph));
          var kc = ka.color(pal);
          q.st[0] = kc[0]; q.st[1] = kc[1]; q.st[2] = kc[2];
          q.wa = pal.wireK * (S.light > 0.5 ? 0.9 : 0.85) * (DESK ? 1.5 : 1); q.alpha = Math.min(1.2, k.alpha == null ? 1 : k.alpha);
          var pb = sf.state === "needs" ? 1 + 0.25 * (k.amb || 0.5) : 1;
          q.lit = pb; q.glowK = pb;
          q.rimK = GLOW ? ((1 - S.light) * 0.14 + S.light * 0.05) * (DESK ? 0.2 : 1) : 0;
          q.stK = GLOW ? ((1 - S.light) * 0.07 + S.light * 0.05) * pb : 0; // faint: the face itself carries the colour
          q.shimA = sf.state === "thinking" && !S.still ? 0.8 : 0; q.shimX = -1.6 + (((ka.t + ka.ph) * 0.62) % 1) * 3.2;
          q.form = k.form == null ? 1 : k.form; q.dis = k.dis || 0;
        }
      }
      if (kidSeen % 120 === 0) Object.keys(kidAnims).forEach(function (kk) { if (kidAnims[kk].seen < kidSeen - 60) delete kidAnims[kk]; });
    }

    /* ---------------- draw (WebGL2) */
    function setHeadU(u, h, fs, dpr, home) {
      gl.uniform2f(u.u_c, h.cx * dpr, (S.cssH - h.cy) * dpr);
      gl.uniform1f(u.u_r, h.r * dpr); gl.uniform1f(u.u_fs, fs); gl.uniform1f(u.u_sc, h.sc);
      gl.uniform1f(u.u_yaw, h.yaw); gl.uniform1f(u.u_tilt, h.tilt); gl.uniform1f(u.u_form, h.form); gl.uniform1f(u.u_dis, h.dis);
      gl.uniform2f(u.u_home, home[0], home[1]);
      gl.uniform1f(u.u_row, h.row); gl.uniform1f(u.u_wa, h.wa); gl.uniform1f(u.u_lit, h.lit); gl.uniform1f(u.u_alpha, h.alpha);
      gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
      gl.uniform1f(u.u_shimX, h.shimX); gl.uniform1f(u.u_shimA, h.shimA);
      var ps = dpr * clamp(h.cssR / 120, 0.55, 1.5);
      gl.uniform1f(u.u_psz, ps); gl.uniform1f(u.u_jsz, 7.2 * ps);
    }
    function drawGL() {
      var cw = canvas.width, ch = canvas.height, dpr = S.dpr, i, h, o, u;
      if (GLOW) ensureFbo(); // (binds its texture: the weights go back on unit 0 just below)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, wtTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NF, ROWS, gl.RED, gl.UNSIGNED_BYTE, W8);
      var home = HOME; HOME[0] = S.c[0]; HOME[1] = S.c[1];
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // 1. the glows, at quarter resolution
      if (GLOW) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, fboW, fboH);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        var fs = fboW / cw;
        gl.useProgram(progQ.p); u = progQ.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, fboW, fboH);
        var dk = 1 - S.light;
        for (i = 0; i < nHeads; i++) {
          h = POOL[i];
          var fa = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
          if (fa < 0.01) continue;
          var X = h.cx * dpr * fs, Y = (S.cssH - h.cy) * dpr * fs, Rr = h.r * dpr * fs, E = Rr * 1.75;
          gl.uniform4f(u.u_box, X - E, Y - E, X + E, Y + E);
          gl.uniform2f(u.u_c, X, Y); gl.uniform1f(u.u_r, Rr); gl.uniform2f(u.u_so, 0, -0.12);
          gl.uniform1f(u.u_rimK, h.rimK * fa); gl.uniform1f(u.u_stK, h.stK * fa);
          var rA = pal.rim[0], rB = pal.rim[1], rl = pal.rimL;
          gl.uniform3f(u.u_rA, (rA[0] * dk + rl[0] * S.light) / 255, (rA[1] * dk + rl[1] * S.light) / 255, (rA[2] * dk + rl[2] * S.light) / 255);
          gl.uniform3f(u.u_rB, (rB[0] * dk + rl[0] * S.light) / 255, (rB[1] * dk + rl[1] * S.light) / 255, (rB[2] * dk + rl[2] * S.light) / 255);
          gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        // the faces' glow: the face layer again, soft-edged (FACE.drawGL, glow pass)
        gl.useProgram(progF.p);
        for (i = 0; i < nHeads; i++) { h = POOL[i]; FACE.drawGL(gl, progF, fvGeo(), h, FVEC[h.row], fboW, fboH, fs, dpr, S.cssH, true, S.light > 0.5, HEADS[h.head].p); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (DESK) {
        gl.useProgram(progP.p); u = progP.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, cw, ch);
        var pk = S.light, pc = PLATE.dark, pl = PLATE.light, pa = PLATE.aDark + (PLATE.aLight - PLATE.aDark) * pk;
        for (i = 0; i < nHeads; i++) {
          h = POOL[i];
          var pf = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
          if (pf < 0.01) continue;
          var PX = h.cx * dpr, PY = (S.cssH - h.cy) * dpr, PR = h.r * dpr * (i ? PLATE.kid : PLATE.core);
          gl.uniform4f(u.u_box, PX - PR, PY - PR, PX + PR, PY + PR);
          gl.uniform2f(u.u_c, PX, PY); gl.uniform1f(u.u_r, PR);
          gl.uniform4f(u.u_col, (pc[0] + (pl[0] - pc[0]) * pk) / 255, (pc[1] + (pl[1] - pc[1]) * pk) / 255, (pc[2] + (pl[2] - pc[2]) * pk) / 255, Math.min(1, pa * pf));
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      if (GLOW) {
        gl.useProgram(progC.p); u = progC.u; gl.bindVertexArray(emptyVao);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fboTex); gl.uniform1i(u.u_tex, 1);
        gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_tx, 1 / fboW, 1 / fboH); gl.uniform1f(u.u_k, S.light > 0.5 ? 1 : 0.6);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, wtTex);
      }
      // 2. the delegation stream
      if (W.deleg > 0.01 && destFn) {
        var dd = destFn();
        if (dd) {
          gl.useProgram(progS.p); u = progS.u; gl.bindVertexArray(emptyVao);
          var c0 = POOL[0];
          gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, c0.cx * dpr, (S.cssH - c0.cy) * dpr); gl.uniform2f(u.u_dest, dd[0] * dpr, (S.cssH - dd[1]) * dpr);
          gl.uniform1f(u.u_r, c0.r * dpr); gl.uniform1f(u.u_bead, S.bead); gl.uniform1f(u.u_deleg, W.deleg); gl.uniform1f(u.u_psz, dpr * 1.6);
          gl.uniform3f(u.u_st, c0.st[0] / 255, c0.st[1] / 255, c0.st[2] / 255);
          gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0);
          gl.drawArrays(gl.POINTS, 0, STREAM);
        }
      }
      // 3. the heads: wireframe, nodes, lit strokes, lit face
      gl.useProgram(progW.p); u = progW.u;
      gl.uniform2f(u.u_res, cw, ch); gl.uniform1i(u.u_wt, 0); gl.uniform1f(u.u_maxPt, maxPt);
      gl.uniform3f(u.u_wire, pal.wire[0] / 255, pal.wire[1] / 255, pal.wire[2] / 255);
      var lineGain = dpr > 1.4 ? 1.25 : 0.85;
      for (i = nHeads - 1; i >= 0 && !S.testNoHead; i--) { // the sessions first, the core on top
        h = POOL[i]; o = geoFor(h.head, h.detail);
        setHeadU(u, h, 1, dpr, home);
        var hInd = i === 0 ? S.ind : null; // look and speak: the core (and the companion bot, which is a core) only, never a session's head
        if (u.u_ind) { gl.uniform1f(u.u_ind, hInd ? 1 : 0); gl.uniform1f(u.u_arm, hInd ? hInd.arm : 0); gl.uniform1f(u.u_indA, hInd ? hInd.k : 0); }
        gl.bindVertexArray(o.vao);
        gl.uniform1f(u.u_pt, 0); gl.uniform1f(u.u_mode, 0); gl.uniform1f(u.u_wa, h.wa * lineGain);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibL); gl.drawElements(gl.LINES, o.geo.lines.length, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(u.u_wa, h.wa);
        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0); gl.uniform1f(u.u_mode, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibP); gl.drawElements(gl.POINTS, o.geo.pts.length, gl.UNSIGNED_SHORT, 0);
        // the face: its own small program on a patch over the front surface
        gl.useProgram(progF.p);
        FACE.drawGL(gl, progF, fvGeo(), h, FVEC[h.row], cw, ch, 1, dpr, S.cssH, false, S.light > 0.5, HEADS[h.head].p);
        gl.useProgram(progW.p);
      }
      // 4. dozing: the z z z
      var zk = zzzK();
      if (zk > 0.01) {
        var c0z = POOL[0];
        gl.useProgram(progZ.p); u = progZ.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, c0z.cx * dpr, (S.cssH - c0z.cy) * dpr); gl.uniform1f(u.u_r, c0z.r * dpr);
        gl.uniform1f(u.u_t, zzzT()); gl.uniform1f(u.u_k, zk); gl.uniform1f(u.u_psz, Math.max(2, 0.036 * c0z.cssR * dpr));
        gl.uniform3f(u.u_st, c0z.st[0] / 255, c0z.st[1] / 255, c0z.st[2] / 255);
        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0); gl.uniform1f(u.u_sq, 1); gl.uniform1f(u.u_mode, 2);
        gl.drawArrays(gl.POINTS, 0, ZN);
      }
      gl.bindVertexArray(null);
    }

    /* ---------------- draw (Canvas 2D) */
    var o2 = { dpr: 1 };
    function draw2d() {
      var dpr = S.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var home = coreCss();
      for (var i = nHeads - 1; i >= 0; i--) {
        var h = POOL[i];
        o2.geo = build(h.head, h.detail); o2.cx = h.cx; o2.cy = h.cy; o2.r = h.r; o2.yaw = h.yaw; o2.tilt = h.tilt; o2.sc = h.sc;
        o2.wire = pal.wire; o2.st = h.st; o2.wa = h.wa; o2.lit = h.lit; o2.alpha = h.alpha; o2.w = W8; o2.off = h.row * NF; o2.light = S.light > 0.5;
        o2.rimA = pal.rim[0]; o2.rimB = pal.rim[1]; o2.rimL = pal.rimL; o2.rimK = h.rimK * 0.8; o2.stK = h.stK * 1.2; o2.form = h.form; o2.dis = h.dis;
        o2.homeX = home[0]; o2.homeY = home[1]; o2.shimX = h.shimX; o2.shimA = h.shimA; o2.dpr = dpr;
        o2.ind = i === 0 ? S.ind : null;
        o2.fv = FVEC[h.row];
        if (DESK) plate2d(ctx, h, i ? PLATE.kid : PLATE.core);
        draw2dHead(ctx, o2);
      }
      var zk = zzzK();
      if (zk > 0.01) {
        var c0 = POOL[0], zt = zzzT(), zs = Math.max(2 / dpr, 0.036 * c0.cssR);
        for (var j = 0; j < ZN; j++) {
          zDot(j, zt, ZP);
          var za = ZP[3] * zk, sz = zs * ZP[2];
          if (za < 0.01) continue;
          ctx.fillStyle = rgba(c0.st, za);
          ctx.fillRect(c0.cx + ZP[0] * c0.r - sz / 2, c0.cy - ZP[1] * c0.r - sz / 2, sz, sz);
        }
      }
    }
    /** How visible the dozing z z z are (0..1), and their clock (a still frame: one fixed moment). */
    function zzzK() { return S.offline || S.state !== "idle" ? 0 : sstep(0.6, 1, S.doze); }
    function zzzT() { return S.still ? 1.3 : S.t; }

    /** The desktop's contrast backplate on the 2D context (the GL one's twin). */
    function plate2d(g, h, k) {
      var pf = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
      if (pf < 0.01) return;
      var pk = S.light, c = [0, 1, 2].map(function (j) { return PLATE.dark[j] + (PLATE.light[j] - PLATE.dark[j]) * pk; });
      var a = Math.min(1, (PLATE.aDark + (PLATE.aLight - PLATE.aDark) * pk) * pf), R = h.r * k;
      var gr = g.createRadialGradient(h.cx, h.cy, 0, h.cx, h.cy, R);
      gr.addColorStop(0, rgba(c, a)); gr.addColorStop(0.45, rgba(c, a)); gr.addColorStop(0.73, rgba(c, a * 0.5)); gr.addColorStop(1, rgba(c, 0));
      g.fillStyle = gr; g.fillRect(h.cx - R, h.cy - R, R * 2, R * 2);
    }

    /* ---------------- simulation + loop */
    function step(dt) {
      S.t += dt;
      var st = S.offline ? "error" : S.state, tg = TARGETS[st] || {}, k = 1 - Math.exp(-dt * 4);
      KEYS.forEach(function (key) { W[key] += ((tg[key] || 0) - W[key]) * k; });
      S.light += (S.lightT - S.light) * (1 - Math.exp(-dt * 4));
      var talking = S.state === "listening" || S.state === "speaking";
      var real = S.ind && S.ind.phase === "paused" ? 0 : talking && ampFn ? ampFn(S.state) : null;
      var target = !talking ? 0 : real == null || real < 0 ? (S.state === "listening" ? synthListen(S.t) : synthAmp(S.t)) : Math.max(0, Math.min(1, real));
      S.amp += (target - S.amp) * (1 - Math.exp(-dt * (target > S.amp ? 24 : 8)));
      S.ampSlow += (S.amp - S.ampSlow) * (1 - Math.exp(-dt * 3));
      S.bead += dt * 0.38;
      S.arrive += ((S.state === "delegating" ? 1 : 0) - S.arrive) * (1 - Math.exp(-dt * 2));
      // the mouth: a viseme from the voice's spectrum (level only without one), eased so shapes flow
      var sp = S.state === "speaking" && real != null && real >= 0 && specFn ? specFn() : null;
      if (S.state === "speaking") viseme(sp ? sp.bins : null, sp ? sp.hz : 0, S.amp, VT);
      else { VT.closed = 1; VT.open = VT.wide = VT.round = 0; }
      var vk = 1 - Math.exp(-dt * 20);
      S.vis.closed += (VT.closed - S.vis.closed) * vk; S.vis.open += (VT.open - S.vis.open) * vk;
      S.vis.wide += (VT.wide - S.vis.wide) * vk; S.vis.round += (VT.round - S.vis.round) * vk;
      // moods: dozing is checked once a second; it settles over ~2 s and lifts at once
      S.dozeChk -= dt;
      if (S.dozeChk <= 0) { S.dozeChk = 1; evalDoze(); }
      S.doze += (S.dozeT - S.doze) * (1 - Math.exp(-dt * (S.dozeT > S.doze ? 0.6 : 6)));
      if (S.rk) { S.rt += dt; if (S.rt >= S.rd) S.rk = ""; }
      prepare(dt);
    }
    /* ---------------- moods, reactions, the pointer, glances */
    function evalDoze() {
      var want = dozeWanted({ state: S.state, offline: S.offline, near: S.near, quietMs: now() - S.actAt, hour: hourOf(), presence: S.presence });
      if (want && !S.dozeT) S.dozeT = 1;
      else if (!want && S.dozeT) wake();
    }
    function wake() {
      S.dozeT = 0;
      if (S.doze > 0.5) { react("wake"); if (opts.onWake) try { opts.onWake(); } catch (e) { /* the page's hook (a chirp) */ } }
      if (S.still) S.doze = 0;
    }
    /** Something happened (a state change, a message, a card, a pointer near): the quiet spell restarts, a dozing bot wakes. */
    function poke() { S.actAt = now(); if (S.dozeT) { wake(); if (S.still) stillFrame(); } }
    var rkTimer = 0;
    /** A short reaction: "surprise" (error / offline), "grin" (a job done), "nod" (approved), "wake". Still frames: the face only. */
    function react(kind) {
      if (!REACT[kind]) return false;
      S.actAt = now();
      if (S.dozeT && kind !== "wake") { S.dozeT = 0; if (S.still) S.doze = 0; }
      if (S.still) {
        if (kind !== "grin" && kind !== "surprise") return false; // motion only: nothing to show in a still frame
        S.rk = kind; S.rt = 0; S.rd = REACT[kind]; S.rkStill = true;
        clearTimeout(rkTimer);
        rkTimer = setTimeout(function () { S.rk = ""; if (S.still) stillFrame(); }, REACT[kind] * 1000);
        stillFrame();
        return true;
      }
      S.rk = kind; S.rt = 0; S.rd = REACT[kind]; S.rkStill = false;
      if (kind === "wake" || kind === "surprise") coreAnim.blinkP = 0;
      return true;
    }
    /** Look at a point (CSS px, or a function giving one each frame) for ms: a session that needs you, a reply. */
    function glance(at, ms) {
      if (!at) return;
      S.gzAt = at; S.gzUntil = S.t + (ms || 1400) / 1000;
      poke();
    }
    var ptrRect = null, ptrRectAt = 0;
    function onPtr(e) {
      var tn = e.timeStamp || 0;
      if (!ptrRect || tn - ptrRectAt > 500 || tn < ptrRectAt) { ptrRect = canvas.getBoundingClientRect(); ptrRectAt = tn; }
      S.ptr[0] = e.clientX - ptrRect.left; S.ptr[1] = e.clientY - ptrRect.top; S.ptrOn = true;
      var cc = coreCss(), r = headR(), dx = S.ptr[0] - cc[0], dy = S.ptr[1] - cc[1], near = dx * dx + dy * dy < r * r * 6.25;
      if (near && !S.near) { S.near = true; poke(); } else S.near = near;
      if (near) S.actAt = now();
    }
    function onPtrOut(e) { if (!e.relatedTarget) { S.ptrOn = false; S.near = false; } }
    function onBlur() { S.ptrOn = false; S.near = false; }
    if (opts.pointer) {
      window.addEventListener("pointermove", onPtr, { passive: true });
      document.addEventListener("pointerout", onPtrOut);
      window.addEventListener("blur", onBlur);
    }
    // still frames (reduced motion, hold still): no loop to notice a quiet spell, so look now and then
    var stillTimer = setInterval(function () {
      if (!S.still || !S.wanted) return;
      var was = S.dozeT; evalDoze();
      if (S.dozeT !== was) { S.doze = S.dozeT; stillFrame(); }
    }, 20000);
    function draw() {
      if (!canvas.width || !canvas.height) return;
      if (!nHeads) prepare(0);
      if (gl) { drawGL(); if (S.headCheck < 2) { checkFrames++; checkHead(); } } else if (ctx) draw2d();
      if (onFrame) onFrame(S, W);
    }
    /*
     * Some GPUs draw the glow and the z z z but not the head itself (user screenshots, 2026-10-25: a soft grey blob
     * in the dock, only the glow in the Command Center; the same page draws the head on others). Once the core's
     * head is fully there, read back a patch over it, right after drawing it: the wireframe makes sharp edges, the
     * glow alone none. No edges twice, a second apart -> this GPU does not draw the head; the 2D renderer does.
     * S.headCheck: 0 not checked yet, 1 failed once, 2 done. Checked again whenever the core starts drawing again
     * (back to the Command Center, the tab shown again) and after the GPU gives a lost context back (rearmHeadCheck).
     */
    var headCheckAt = 0, checkFrames = 0;
    function rearmHeadCheck() { S.headCheck = 0; headCheckAt = 0; checkFrames = 0; }
    function checkHead() {
      var c0 = POOL[0];
      if (!c0 || S.ctxLost || c0.alpha < 0.95 || c0.form < 1 || c0.dis > 0 || c0.wa < 0.3 || checkFrames < 20) return;
      var t = performance.now();
      if (t < headCheckAt) return;
      var dpr = S.dpr, hr = Math.max(6, Math.round(0.45 * c0.r * dpr)), cx = Math.round(c0.cx * dpr), cy = Math.round((S.cssH - c0.cy) * dpr);
      var x0 = Math.max(0, cx - hr), y0 = Math.max(0, cy - hr), w = Math.min(canvas.width, cx + hr) - x0, h = Math.min(canvas.height, cy + hr) - y0;
      if (w < 8 || h < 8) return;
      var px = new Uint8Array(w * h * 4), edges = 0, i, j, k;
      try { gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) { S.headCheck = 2; return; }
      for (j = 0; j < h; j++) for (i = 1; i < w; i++) { k = (j * w + i) * 4 + 3; if (Math.abs(px[k] - px[k - 4]) > 48) edges++; }
      S.headEdges = edges;
      if (edges >= 8) { S.headCheck = 2; return; }
      if (S.headCheck === 0) { S.headCheck = 1; headCheckAt = t + 1000; return; }
      S.headCheck = 2;
      var info = "";
      try { var dbg = gl.getExtension("WEBGL_debug_renderer_info"); info = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ""; } catch (e) { info = ""; }
      if (window.console) console.warn("[core E] this GPU does not draw the head (" + (info || "unknown renderer") + "); drawing in 2D");
      setTimeout(function () { to2D(true); }, 0);
    }
    var slowSince = 0;
    function guard(now) {
      if (S.lowRes || opts.noGuard || S.frames.length < 30) return;
      var f = S.frames, iv = (f[f.length - 1][0] - f[f.length - 30][0]) / 29;
      if (iv > 22) { if (!slowSince) slowSince = now; else if (now - slowSince > 2000) { S.lowRes = true; if (lastSize) resize.apply(null, lastSize); if (window.console) console.info("[core E] drawing at 0.7x resolution (" + iv.toFixed(1) + " ms a frame)"); } }
      else slowSince = 0;
    }
    function frame(now) {
      raf = 0;
      if (!S.running) return;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      var t0 = performance.now();
      if (opts.beforeDraw) opts.beforeDraw(S, W); // the family moves first, so heads and names agree
      step(dt);
      draw();
      S.frames.push([now, performance.now() - t0]);
      if (S.frames.length > 360) S.frames.shift();
      guard(now);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      S.wanted = true;
      if (S.still) { stillFrame(); return; }
      if (S.running || document.hidden) return;
      S.running = true; last = 0; raf = requestAnimationFrame(frame);
      if (gl) rearmHeadCheck();
    }
    function stop(keep) { S.running = false; if (!keep) S.wanted = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    /** One still frame of the current state (reduced motion, hold still): the face fully there, eyes open, no sway. */
    function stillFrame() {
      var st = S.offline ? "error" : S.state, tg = TARGETS[st] || {};
      KEYS.forEach(function (k) { W[k] = tg[k] || 0; });
      S.light = S.lightT;
      S.amp = S.state === "listening" || S.state === "speaking" ? 0.55 : 0;
      if (S.rk && !S.rkStill) S.rk = ""; // a reaction the loop was playing does not freeze into a still frame
      S.doze = S.dozeT; S.lookK = 0; viseme(null, 0, S.amp, S.vis);
      var wasStill = S.still; S.still = true;
      prepare(0);
      coreAnim.settle(); Object.keys(kidAnims).forEach(function (k) { kidAnims[k].settle(); });
      prepare(0);
      S.still = wasStill;
      if (canvas.width && canvas.height) { if (gl) drawGL(); else if (ctx) draw2d(); if (onFrame) onFrame(S, W); }
    }
    function onVis() { if (document.hidden) stop(true); else if (S.wanted) start(); }
    document.addEventListener("visibilitychange", onVis);
    function onReduce() { S.still = reduceMq.matches; if (S.still) { stop(true); stillFrame(); } else if (S.wanted) start(); }
    if (reduceMq && reduceMq.addEventListener) reduceMq.addEventListener("change", onReduce);
    function resize(cx, cy, R, w, h) {
      lastSize = [cx, cy, R, w, h];
      var dpr = Math.min(window.devicePixelRatio || 1, 2) * (S.lowRes ? 0.7 : 1);
      w = w || canvas.clientWidth || window.innerWidth; h = h || canvas.clientHeight || window.innerHeight;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      S.cssW = w; S.cssH = h; S.dpr = dpr;
      S.c = [cx * dpr, (h - cy) * dpr]; S.R = R * dpr;
      if (S.still || !S.running) { prepare(0); draw(); }
    }
    function stats() {
      var f = S.frames; if (f.length < 10) return null;
      var cost = f.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; }), iv = [];
      for (var i = 1; i < f.length; i++) iv.push(f[i][0] - f[i - 1][0]);
      iv.sort(function (a, b) { return a - b; });
      var med = function (a) { return a[Math.floor(a.length / 2)]; }, p95 = function (a) { return a[Math.floor(a.length * 0.95)]; };
      return { cpuMed: med(cost), cpuP95: p95(cost), interval: med(iv), intervalP95: p95(iv), fps: 1000 / med(iv), n: f.length, gl: !!gl };
    }
    function redrawIfIdle() { if (S.still) stillFrame(); else if (!S.running) { prepare(0); draw(); } }
    // the page's face style changed (JoyaBot.setFace, or Settings in another tab): follow it unless this core has its own
    function onPageFace() { if (S.faceOwn) return; var f = faceNow(); if (f !== S.face) { S.face = f; redrawIfIdle(); } }
    LIVE.push(onPageFace);

    if (initGL()) S.gl = true; else ctx = canvas.getContext("2d");

    /*
     * The GPU can drop a WebGL context (a laptop waking from sleep, a driver reset, too many contexts).
     * Nothing caught that, so the head vanished and only the glow and the z z z stayed (user screenshot,
     * 2026-10-25, Command Center and dock alike). Now the context is kept restorable and everything is
     * rebuilt when it comes back; if it does not come back within 4 s, the core draws in 2D instead.
     */
    var lostTimer = 0, destroyed = false;
    function to2D(quiet) {
      if (destroyed) return;
      var lose = gl && !S.ctxLost && gl.getExtension("WEBGL_lose_context"); // free the GPU side of a context we leave
      S.ctxLost = false; gl = null; geos = {}; fvGrid = null; fbo = null; fboTex = null; fboW = 0; fboH = 0;
      canvas.removeEventListener("webglcontextlost", onCtxLost); canvas.removeEventListener("webglcontextrestored", onCtxRestored);
      if (canvas.parentNode) { var fresh = canvas.cloneNode(false); canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; }
      if (lose) try { lose.loseContext(); } catch (e) { /* already gone */ }
      ctx = canvas.getContext("2d"); S.gl = false;
      if (!quiet && window.console) console.warn("[core E] the GPU context did not come back; drawing in 2D");
      if (S.wanted) start(); else redrawIfIdle();
    }
    function onCtxLost(e) {
      if (destroyed) return;
      e.preventDefault(); // without this the browser never restores it
      S.ctxLost = true; stop(true);
      clearTimeout(lostTimer); lostTimer = setTimeout(function () { if (S.ctxLost) to2D(); }, 4000);
    }
    function onCtxRestored() {
      if (destroyed) return;
      clearTimeout(lostTimer); S.ctxLost = false;
      geos = {}; fvGrid = null; fbo = null; fboTex = null; fboW = 0; fboH = 0; // the old objects died with the context
      if (initGL()) S.gl = true; else { gl = null; ctx = canvas.getContext("2d"); S.gl = false; }
      rearmHeadCheck(); // the head must be seen again on the new context
      if (S.wanted) start(); else redrawIfIdle();
    }
    /*
     * A page that goes away (a Settings page in the Command Center's frame, opened and left again and again) hands its
     * GPU contexts back at once: the browser keeps only about 16 and takes the oldest -- the Command Center's own -- when
     * more are open (user screenshot 2026-10-25: after several Settings visits only the glow was left).
     */
    function onPageHide(e) {
      if (destroyed || (e && e.persisted)) return;
      destroyed = true; clearTimeout(lostTimer); stop(false);
      try { var lc = gl && gl.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); } catch (x) { /* gone already */ }
    }
    window.addEventListener("pagehide", onPageHide);
    if (gl) { canvas.addEventListener("webglcontextlost", onCtxLost, false); canvas.addEventListener("webglcontextrestored", onCtxRestored, false); }
    mixPal(); coreAnim.color(pal); coreAnim.pcol = coreAnim.rgb.slice();

    return {
      S: S, W: W, STATES: STATES,
      get isGL() { return !!gl; },
      get canvas() { return canvas; },
      setState: function (s) { if (STATES.indexOf(s) < 0) s = "idle"; if (s === S.state) return; S.state = s; poke(); if (S.still) stillFrame(); },
      /** JOYA AI unreachable: red x x, still (the Command Center's offline state). */
      setOffline: function (on) { on = !!on; if (on === S.offline) return; S.offline = on; if (on) react("surprise"); else { if (S.rk === "surprise") S.rk = ""; poke(); } redrawIfIdle(); },
      /** Expressive (2026-10-20): something happened (poke), a reaction (react), a look at a point (glance), the pointer by hand (look). */
      poke: poke, react: react, glance: glance,
      /**
       * Eye contact (2026-10-20, joya-presence-bind.js): the camera's state -- "present" | "looking" | "away", or
       * null with the camera off (the 10-minute timer again). Back from away: it wakes and looks up; away: it dozes.
       */
      presence: function (p) {
        p = p === "present" || p === "looking" || p === "away" ? p : null;
        var was = S.presence;
        if (p === was) return;
        S.presence = p;
        if (p && p !== "away") {
          S.actAt = now();
          if (was === "away") S.lookUpUntil = S.t + 0.9; // sat down again: it looks up at them
          if (S.dozeT && (was === "away" || p === "looking")) { wake(); if (S.still) stillFrame(); }
        }
        S.dozeChk = 0; // checked on the next frame
        if (S.still || !S.running) { var d = S.dozeT; evalDoze(); if (S.dozeT !== d) { S.doze = S.dozeT; if (S.still) stillFrame(); } }
      },
      /** Where the person is, seen from the bot ({x, y} in -1..1; x right, y down), or null: the eyes go there. */
      contact: function (g) { S.contact = g && isFinite(g.x) && isFinite(g.y) ? { x: clamp(+g.x, -1, 1), y: clamp(+g.y, -1, 1) } : null; },
      look: function (x, y) { if (x == null) { S.ptrOn = false; S.near = false; return; } S.ptr[0] = x; S.ptr[1] = y; S.ptrOn = true; var cc = coreCss(), r = headR(), dx = x - cc[0], dy = y - cc[1]; S.near = dx * dx + dy * dy < r * r * 6.25; if (S.near) poke(); },
      /** Checks: whether it would doze now (and evaluate it). */
      _doze: function () { evalDoze(); return S.dozeT; },
      setLight: function (on, instant) { S.lightT = on ? 1 : 0; if (instant) S.light = S.lightT; if (S.still || !S.running) { S.light = S.lightT; redrawIfIdle(); } },
      /** The head style (one of JoyaBot.HEADS); the sessions follow. */
      /**
       * Look and speak (2026-10-21, joya-presence-bind.js): indicate({ phase, arm, armMs }) or null. phase "arming"
       * (arm 0..1 now, filling to 1 over armMs), "ready" (with one nod as it arrives), "listening", "paused".
       * Drawn on the head itself: its front edge's nodes, its eyes. A still frame per change in reduced motion.
       */
      indicate: function (o) {
        var was = S.ind, ph = o && o.phase;
        if (!ph || ["arming", "ready", "listening", "paused"].indexOf(ph) < 0) { if (was) { S.ind = null; redrawIfIdle(); } return; }
        var arm = Math.max(0, Math.min(1, +o.arm || 0));
        if (was && was.phase === ph && ph !== "arming") return;
        if (was && ph === "arming" && was.phase === "arming" && arm + 0.1 >= was.arm0 && was.armS) return; // the same hold: keep filling
        S.ind = { phase: ph, arm0: arm, armT: S.t, armS: ph === "arming" && o.armMs > 0 ? o.armMs / 1000 : 0, arm: ph === "arming" ? arm : 1, k: 0 };
        if (ph === "ready" && (!was || was.phase === "arming") && !S.still) react("nod");
        redrawIfIdle();
      },
      /** Didn't recognise the voice (2026-10-21): a small headshake (a still frame shows nothing). */
      shake: function () { return react("shake"); },
      setHead: function (id) { if (!HEADS[id] || id === S.head) return; S.head = id; redrawIfIdle(); },
      /** The face style, "smooth" | "dots" | "minimal", for this core only (null: follow the page's, JoyaBot.setFace). */
      setFace: function (f) { S.faceOwn = f ? FACE.norm(f) : null; var n = S.faceOwn || faceNow(); if (n !== S.face) { S.face = n; redrawIfIdle(); } return S.face; },
      /** The colours ({p, c} as JoyaLogic.normBotColors gives); every head takes them at once. */
      setColors: function (c) { colors = c; PAL = palettes(colors); redrawIfIdle(); },
      resize: resize, start: start, stop: function () { stop(false); }, still: stillFrame, stats: stats,
      /** Draw now (reduced motion / a stopped core: the sessions moved, so the heads are gathered again first). */
      draw: function () { if (!S.running) prepare(0); draw(); },
      resetStats: function () { S.frames = []; },
      setGuard: function (on) { opts.noGuard = !on; },
      /** Driven from outside (joya-shell.js's flight): move without drawing (place), then advance and draw one frame (tick). */
      place: function (cx, cy, R) { lastSize = [cx, cy, R, S.cssW, S.cssH]; S.c = [cx * S.dpr, (S.cssH - cy) * S.dpr]; S.R = R * S.dpr; },
      tick: function (dt) {
        if (!gl && !ctx) return;
        if (opts.beforeDraw) opts.beforeDraw(S, W);
        step(Math.max(0, Math.min(0.05, dt || 0.016)));
        draw();
      },
      /** Carry on exactly where another core E left off: state, weights, voice level, face and phases. */
      adopt: function (o) {
        if (!o || !o.S || o.S.concept !== "E") return;
        var a = o.S;
        // (never a NaN carried over: one in the gaze would hide the head for good)
        ["t", "amp", "ampSlow", "bead", "arrive", "light", "lightT", "doze", "dozeT", "actAt"].forEach(function (k) { if (typeof a[k] === "number" && isFinite(a[k])) S[k] = a[k]; });
        S.state = a.state; S.offline = !!a.offline; if (a.head && HEADS[a.head]) S.head = a.head;
        KEYS.forEach(function (k) { if (typeof o.W[k] === "number") W[k] = o.W[k]; });
        if (o._anim) { var src = o._anim(); ["face", "prev", "fk", "col", "ck", "t", "blinkAt", "blinkP", "gx", "gy", "glanceAt", "glanceUntil"].forEach(function (k) { var v = src[k]; if (typeof v === "number" ? isFinite(v) : v != null) coreAnim[k] = v; }); coreAnim.pcol = src.pcol.slice(); }
      },
      _anim: function () { return coreAnim; },
      setConcept: function () {},
      /** Stop and give the GPU context back (cc-map.js calls it before swapping to another core). */
      destroy: function () {
        destroyed = true; clearTimeout(lostTimer); window.removeEventListener("pagehide", onPageHide);
        canvas.removeEventListener("webglcontextlost", onCtxLost); canvas.removeEventListener("webglcontextrestored", onCtxRestored);
        stop(false);
        var li = LIVE.indexOf(onPageFace); if (li >= 0) LIVE.splice(li, 1);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pointermove", onPtr); document.removeEventListener("pointerout", onPtrOut); window.removeEventListener("blur", onBlur);
        clearInterval(stillTimer); clearTimeout(rkTimer);
        if (reduceMq && reduceMq.removeEventListener) reduceMq.removeEventListener("change", onReduce);
        try { freeGeos(); var lc = gl && gl.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); } catch (e) { /* gone already */ }
        gl = null; ctx = null;
      },
    };
  }

  /**
   * A still picture of one head for the Settings pickers (Canvas 2D, no loop): thumb(canvas, head,
   * { state, light, colors, w, h }). The canvas is sized for the device pixel ratio.
   */
  function thumb(canvas, head, o) {
    o = o || {};
    var w = o.w || canvas.clientWidth || 96, h = o.h || canvas.clientHeight || 96, dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var g = canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var P = palettes(o.colors || null)[o.light ? "light" : "dark"], fo = FACE_OF[o.state] || FACE_OF.idle, an = new Anim(5);
    an.set(fo.face, fo.state); an.settle();
    var w8 = new Uint8Array(NF), fv = new Float32Array(FACE.N), r = Math.min(w, h) * 0.3, cfg = HEADS[head] || HEADS.cap;
    FACE.vec(o.face ? FACE.norm(o.face) : faceNow(), an, r, dpr, fo.face === "speak" ? 0.6 : 0, null, fv, w8, 0);
    draw2dHead(g, {
      geo: build(HEADS[head] ? head : "cap", r >= 60 ? "hi" : "lo"), cx: w / 2, cy: h / 2 + r * 0.3, r: r, yaw: cfg.yaw, tilt: cfg.tilt || 0.1, sc: 1,
      wire: P.wire, st: P[fo.state], wa: P.wireK * 1.3, lit: 1, alpha: 1, w: w8, off: 0, light: !!o.light, rimA: P.rim[0], rimB: P.rim[1], rimL: P.rimL,
      rimK: o.light ? 0.035 : 0.26, stK: o.light ? 0.1 : 0.22, form: 1, dis: 0, homeX: 0, homeY: 0, shimX: 0, shimA: 0, dpr: dpr, fv: fv,
    });
  }

  return {
    create: create, thumb: thumb, build: build, HEADS: HEADS, HEAD_IDS: HEAD_IDS, XHEADS: XHEADS, Anim: Anim,
    FACE_OF: FACE_OF, coreFace: coreFace, sessState: sessState, NF: NF, GN: GN, G: G,
    // the face (2026-10-22): its styles and their names, the page's style (read, set live), the vector and its coverage
    FACE: FACE, FACE_STYLES: Object.keys(FACE.STY), FACE_NAMES: FACE.NAMES, normFace: FACE.norm, face: faceNow, setFace: setPageFace, faceVec: FACE.vec, faceCov: FACE.covAt,
    viseme: viseme, VIS: VIS, dozeWanted: dozeWanted, isNight: isNight, DOZE_QUIET_MS: DOZE_QUIET_MS, NIGHT_QUIET_MS: NIGHT_QUIET_MS, pickFace: pickFace, REACT: REACT, zDot: zDot, ZN: ZN,
  };
});
