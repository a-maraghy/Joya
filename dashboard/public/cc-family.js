"use strict";
/*
 * The Command Center's "family of spheres" (Flat): the live sessions as small
 * dotted-sphere replicas of JOYA AI, with their names, drifting freely round
 * her -- the approved mockup (scratchpad/session-family, v2, Flat), on real data.
 *
 *   - one sphere per live session, its own tint (from its name), sized by what
 *     it did today; a kept ring under every session the administrator runs
 *     or keeps; a session JOYA AI hired (`hired: true`, M-6) has no ring and a
 *     small "hired" tag by its name;
 *   - working ones shimmer and turn faster, idle ones dim, one waiting on you
 *     glows amber with a pulsing "needs you" badge; one that just finished
 *     blooms and shows "done";
 *   - a delegation is a stream of dots from JOYA AI to that sphere, a reply a
 *     thinner thread back (real supervisor events, through send() / reply());
 *   - its running sub-agents (real data) are specks circling it;
 *   - a session that appears condenses out of her; one that goes away
 *     dissolves back into her (a retired one too: retiring is the supervisor's,
 *     after the administrator's consent -- nothing here retires anything);
 *   - hover: a card with its task, last message and tokens today; click (or
 *     Enter on its name) opens that session's existing deep view; right-click
 *     (or the context-menu key on its name) calls opts.onMenu(id, x, y).
 *
 * The spheres never overlap JOYA AI, each other, the caption, the composer or
 * voice bar, the approval card, the icon rail, the top bar or an open panel:
 * a soft pull toward a loose ellipse round her, soft repulsion, gentle wander,
 * then hard guarantees each frame. It rides the core's own animation frame
 * (cc-map.js calls frame()); with prefers-reduced-motion it settles once and
 * draws a still frame per change. Positions are set through the CSSOM (the CSP
 * refuses style attributes).
 *
 * With core D (the mesh, joya-core-d.js) the spheres themselves are small mesh
 * replicas drawn by the core, on its own WebGL2 canvas, in one batch: setMesh(true)
 * stops the dotted 2D sphere here and meshKids() hands the core, each frame,
 * where each one is and how it looks (size, tint, dim / shimmer, amber, born /
 * dissolving, catching a delegation). Everything else -- names, badges, rings,
 * sub-agents, streams, hover, click, drift -- stays here, unchanged. Core E (the bot,
 * joya-core-bot.js) takes the same list and draws each session as a small bot head in
 * the core's style, its face and colour from the session's state (key / st / glow / bloom).
 *
 * window.JoyaFamily(els, opts) -> instance. els: { root, canvas, labels, card };
 * opts: { layout() -> {cx, cy, R}, obstacles() -> [rects], light() -> bool,
 * sceneRight() -> px, onClick(id) }.
 */
(function () {
  var PI = Math.PI, TAU = PI * 2;
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function ease(p) { return p * p * (3 - 2 * p); }
  function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function rgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a.toFixed(3) + ")"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* the golden-angle sphere of core C, in 2D */
  function points(n, s) {
    var dir = new Float32Array(n * 3), rnd = new Float32Array(n * 2), ga = PI * (3 - Math.sqrt(5)), sd = s;
    function r_() { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = ga * i;
      var x = Math.cos(th) * rad + (r_() - 0.5) * 0.035, yy = y + (r_() - 0.5) * 0.035, z = Math.sin(th) * rad + (r_() - 0.5) * 0.035;
      var l = Math.hypot(x, yy, z);
      dir[i * 3] = x / l; dir[i * 3 + 1] = yy / l; dir[i * 3 + 2] = z / l; rnd[i * 2] = r_(); rnd[i * 2 + 1] = r_();
    }
    return { dir: dir, rnd: rnd, n: n };
  }
  var PC = points(240, 11);

  var C = {
    dark: { joya: [0, 230, 165], cyan: [64, 199, 196], vio: [153, 77, 255], amb: [250, 189, 77], ring: [0, 230, 165] },
    light: { joya: [0, 143, 102], cyan: [8, 128, 143], vio: [115, 33, 196], amb: [204, 115, 0], ring: [0, 120, 90] },
  };
  var TINTS = {
    teal: { dark: [45, 212, 191], light: [12, 128, 116], css: "#14B8A6" },
    violet: { dark: [176, 118, 255], light: [112, 38, 196], css: "#8A2BE2" },
    blue: { dark: [96, 165, 250], light: [36, 96, 204], css: "#3B82F6" },
    green: { dark: [120, 232, 150], light: [20, 136, 72], css: "#22C55E" },
    orchid: { dark: [232, 121, 249], light: [160, 40, 172], css: "#C026D3" },
    cyan: { dark: [56, 214, 240], light: [8, 118, 150], css: "#06B6D4" },
    pink: { dark: [246, 120, 186], light: [184, 40, 112], css: "#DB2777" },
  };
  var TINT_KEYS = Object.keys(TINTS);
  function palette(a, b, c) { var out = []; for (var i = 0; i < 32; i++) { var k = i / 31; out.push(rgb(k < 0.5 ? mix3(a, b, k * 2) : mix3(b, c, (k - 0.5) * 2))); } return out; }

  window.JoyaFamily = function (els, opts) {
    opts = opts || {};
    var cv = els.canvas, g = cv.getContext("2d"), labels = els.labels, card = els.card;
    var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var DPR = 1, W = 0, H = 0, phone = false, light = false, t = 0, last = 0, on = false;
    var seed = 1234567;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var PAL = {};
    var L = { cx: 0, cy: 0, R: 100, rBase: 24, fax: 200, fay: 120, sceneR: 0, top: 60 };
    var kids = [];             // live and dissolving spheres
    var parts = [];            // delegation / reply dots
    var ghosts = [];           // a delegation's target with no sphere (remote, sub-agent, offline, ambiguous): a marker at the edge
    var glow = 0;              // her glow when a sphere dissolves into her
    var first = true;          // the first list is placed, not born
    var hoverKid = null, mouse = { x: -1, y: -1, over: false };
    var cost = [], iv = [];
    var mesh = false;          // core D draws the spheres (meshKids); this canvas keeps the rest

    function buildPalettes() {
      var c = light ? C.light : C.dark;
      PAL.main = palette(c.joya, c.cyan, c.vio);
      PAL.amb = palette(mix3(c.amb, [255, 230, 170], light ? 0 : 0.25), c.amb, mix3(c.amb, [200, 90, 0], 0.4));
      TINT_KEYS.forEach(function (k) { var tc = TINTS[k][light ? "light" : "dark"]; PAL[k] = palette(mix3(tc, c.joya, 0.38), tc, mix3(tc, c.vio, 0.38)); });
    }

    /* ---------------------------------------------------------- layout */
    function computeLayout() {
      var lay = opts.layout ? opts.layout() : { cx: innerWidth / 2, cy: innerHeight / 2, R: 150 };
      W = innerWidth; H = innerHeight; phone = W <= 720 && !document.documentElement.classList.contains("cc-desk"); // the desktop app's box is small, but has a mouse
      L.cx = lay.cx; L.cy = lay.cy; L.R = lay.R;
      L.sceneR = opts.sceneRight ? opts.sceneRight() : W;
      L.top = opts.top ? opts.top() : 60;
      L.rBase = phone ? 19 : clamp(L.R / 7.5, 18, 32);
      var mar = 44 + L.rBase;
      L.fax = Math.max(L.R + 60, Math.min(Math.max(L.cx, L.sceneR - L.cx) - mar, L.R * (phone ? 2.2 : 2.3)));
      L.fay = Math.max(L.R * 0.7, Math.min(L.R * (phone ? 2.4 : 1.25), H * 0.42));
    }
    function resize() {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      computeLayout();
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      cv.style.width = W + "px"; cv.style.height = H + "px";
      if (reduced) settle(160);
      draw();
    }
    function kidTargetR(k) {
      var maxA = 1; kids.forEach(function (o) { if (!o.dead && !o.dis) maxA = Math.max(maxA, o.act); });
      return L.rBase * (0.78 + 0.55 * Math.sqrt(k.act / maxA));
    }

    /* rectangles the spheres stay clear of, refreshed a few times a second */
    var rects = [], rectsAt = -1;
    function refreshRects() {
      rects = opts.obstacles ? opts.obstacles() : [];
      // The floor of the stage: the top of the bottom band (caption, composer / voice bar, hint).
      // Spheres stay above it, never in the strip under the message bar (2026-10-25: a session
      // parked under the composer looked like it had left the canvas).
      var f = H;
      rects.forEach(function (rc) { if ((rc.name === "composer" || rc.name === "caption") && rc.t > H * 0.45) f = Math.min(f, rc.t); });
      L.floor = f;
      if (L.cy < f) L.fay = Math.max(L.R * 0.7, Math.min(L.fay, f - L.cy - (L.rBase * 1.2 + 60))); // the drift ellipse ends above it too
    }
    function yMax(k) { var r = k.r, lo = L.top + r + 30, hi = Math.min(H - 12 - r * 1.2 - 40, (L.floor || H) - r * 1.2 - 34); return Math.max(lo, hi); }
    function kidBox(k, x, y) { var r = k.r, hw = Math.max(r * 1.1, k.lw / 2 + 4); return { l: x - hw, r: x + hw, t: y - r - (k.badge ? 30 : 6), b: y + r * 1.2 + 40 }; }
    function pen(a, b, pad) {
      if (a.r < b.l - pad || a.l > b.r + pad || a.b < b.t - pad || a.t > b.b + pad) return null;
      var px1 = b.r + pad - a.l, px2 = a.r - (b.l - pad), py1 = b.b + pad - a.t, py2 = a.b - (b.t - pad);
      // The way out is the shortest one that keeps the sphere and its name on screen: pushing a
      // sphere down past the composer used to drop it below the window (2026-10-25, a session
      // seen with only its antenna showing at the bottom edge).
      var ways = [[px1, px1, 0], [px2, -px2, 0], [py1, 0, py1], [py2, 0, -py2]].filter(function (w) {
        return a.l + w[1] >= 0 && a.r + w[1] <= L.sceneR && a.t + w[2] >= L.top && a.b + w[2] <= H;
      });
      if (!ways.length) ways = [[py2, 0, -py2]]; // nowhere fits: up, towards the open middle, never off the bottom
      ways.sort(function (x, y) { return x[0] - y[0]; });
      return [ways[0][1], ways[0][2]];
    }
    function herMin(k, dy, hd) {
      var up = Math.max(0, -dy / hd);
      return L.R + 22 + k.r + (k.r * 0.2 + 40) * up; // the name sits under the sphere: more room when above her
    }

    /* ---------------------------------------------------------- physics (Flat) */
    function physics(dt) {
      var live = kids.filter(function (k) { return !k.dead && !k.dis; });
      var n = live.length, cx = L.cx, cy = L.cy, ax_ = L.fax, ay_ = L.fay;
      var perim = PI * (3 * (ax_ + ay_) - Math.sqrt((3 * ax_ + ay_) * (ax_ + 3 * ay_)));
      var range = Math.max(150, perim / Math.max(1, n) * 0.85);
      for (var i = 0; i < n; i++) {
        var k = live[i], ax = 0, ay = 0;
        var dx = k.x - cx, dy = k.y - cy, u = dx / ax_, v = dy / ay_, e = Math.hypot(u, v) || 0.001;
        var tx = cx + ax_ * u / e, ty = cy + ay_ * v / e;
        ax += (tx - k.x) * 0.28; ay += (ty - k.y) * 0.28;
        var Tx = -ax_ * v / e, Ty = ay_ * u / e, Tl = Math.hypot(Tx, Ty) || 1; Tx /= Tl; Ty /= Tl;
        var vt = k.vx * Tx + k.vy * Ty, vtT = 0.045 * (ax_ + ay_) / 2 * (0.8 + 0.4 * Math.sin(k.ph[3]));
        ax += (vtT - vt) * Tx * 0.35; ay += (vtT - vt) * Ty * 0.35;
        ax += (6 * Math.sin(t * 0.17 + k.ph[0]) + 3.5 * Math.sin(t * 0.31 + k.ph[1])) * 0.5;
        ay += (4.5 * Math.sin(t * 0.23 + k.ph[2]) + 2.5 * Math.sin(t * 0.41 + k.ph[3])) * 0.5;
        for (var j = 0; j < n; j++) {
          var q = live[j]; if (q === k) continue;
          var ddx = k.x - q.x, ddy = (k.y - q.y) * 1.2, d = Math.hypot(ddx, ddy) || 0.01, rr = Math.max(range, k.r + q.r + 90);
          if (d < rr) { var f = 170 * Math.pow(1 - d / rr, 2); ax += ddx / d * f; ay += ddy / d * f * 0.8; }
        }
        var hd = Math.hypot(dx, dy) || 0.01, minD = herMin(k, dy, hd), soft = minD * 1.3;
        if (hd < soft) { var hf = 140 * (1 - hd / soft); ax += dx / hd * hf; ay += dy / hd * hf; }
        rects.forEach(function (rc) { var p = pen(kidBox(k, k.x, k.y), rc, 18); if (p) { ax += p[0] * 3; ay += p[1] * 3; } });
        var ym = yMax(k); if (k.y > ym - 20) ay -= (k.y - (ym - 20)) * 4;
        k.vx += ax * dt; k.vy += ay * dt;
        var damp = Math.exp(-dt * 1.1); k.vx *= damp; k.vy *= damp;
        var sp = Math.hypot(k.vx, k.vy); if (sp > 38) { k.vx *= 38 / sp; k.vy *= 38 / sp; }
      }
      live.forEach(function (k) { k.x += k.vx * dt; k.y += k.vy * dt; });
      guarantee(live);
    }
    /* the hard rules: on screen, clear of her, of the chrome and of each other */
    function guarantee(live) {
      var n = live.length;
      for (var pass = 0; pass < 4; pass++) {
        live.forEach(function (k) {
          var r = k.r, hw = Math.max(r, k.lw / 2);
          k.x = clamp(k.x, 12 + hw, Math.max(12 + hw, L.sceneR - 12 - hw));
          k.y = clamp(k.y, L.top + r + 30, yMax(k));
          var dx = k.x - L.cx, dy = k.y - L.cy, hd = Math.hypot(dx, dy) || 0.01, minD = herMin(k, dy, hd);
          if (hd < minD) { k.x = L.cx + dx / hd * minD; k.y = L.cy + dy / hd * minD; }
          rects.forEach(function (rc) { var p = pen(kidBox(k, k.x, k.y), rc, 0); if (p) { k.x += p[0]; k.y += p[1]; } });
        });
        for (var a = 0; a < n; a++) {
          for (var b = a + 1; b < n; b++) {
            var p = live[a], q = live[b];
            var ddx = p.x - q.x, ddy = (p.y - q.y) * 0.45, dd = Math.hypot(ddx, ddy) || 0.01;
            var mn = Math.max(p.r + q.r + 50, (p.lw + q.lw) / 2 + 18);
            if (dd < mn) { var push = mn - dd, ux = ddx / dd, uy = ddy / dd; p.x += ux * push * 0.5; p.y += uy * push * 0.25; q.x -= ux * push * 0.5; q.y -= uy * push * 0.25; }
          }
        }
      }
      // last word: whatever the pushes above did, every sphere ends on screen
      live.forEach(function (k) {
        var r = k.r, hw = Math.max(r, k.lw / 2);
        k.x = clamp(k.x, 12 + hw, Math.max(12 + hw, L.sceneR - 12 - hw));
        k.y = clamp(k.y, L.top + r + 30, yMax(k));
      });
    }
    function freeSpot() { // the point on the ellipse furthest from everyone
      var best = null, bs = -1e9, others = kids.filter(function (k) { return !k.dead && !k.dis; });
      for (var i = 0; i < 48; i++) {
        var a = TAU * i / 48, x = L.cx + Math.cos(a) * L.fax, y = L.cy + Math.sin(a) * L.fay, sc = 1e6;
        others.forEach(function (k) { sc = Math.min(sc, Math.hypot(x - k.x, y - k.y)); });
        if (sc > bs) { bs = sc; best = { x: x, y: y }; }
      }
      return best || { x: L.cx + L.fax, y: L.cy };
    }
    function placeAll() {
      var live = kids.filter(function (k) { return !k.dead && !k.dis; }), n = live.length;
      live.forEach(function (k, i) {
        k.r = kidTargetR(k);
        var a = -PI * 0.15 + TAU * i / Math.max(1, n) + (rand() - 0.5) * 0.2;
        k.x = L.cx + Math.cos(a) * L.fax; k.y = L.cy + Math.sin(a) * L.fay; k.vx = k.vy = 0;
      });
      settle(240);
    }
    function settle(steps) {
      refreshRects();
      kids.forEach(function (k) { if (!k.dead && !k.dis) { k.r = kidTargetR(k); measure(k); } });
      for (var s = 0; s < steps; s++) { t += 0.05; physics(0.05); }
    }

    /* ---------------------------------------------------------- the spheres */
    function makeKid(d, born) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "cc-kid";
      el.setAttribute("data-kid", d.id);
      el.innerHTML = '<span class="badge" aria-hidden="true"></span><span class="nm"></span>';
      labels.appendChild(el);
      var k = {
        id: d.id, x: 0, y: 0, vx: 0, vy: 0, r: L.rBase, rot: rand() * TAU, ph: [rand() * TAU, rand() * TAU, rand() * TAU, rand() * TAU],
        glow: 0, catchK: 0, bloom: 0, fold: 0, amb: 0, lift: 0, bright: 1, form: born && !reduced ? 0 : 1, dis: 0, dead: false, hover: 0,
        subs: [], doneUntil: 0, lw: 110, el: el, elB: el.firstChild, elN: el.lastChild, badge: "",
      };
      apply(k, d, true);
      k.amb = k.st === "waiting" ? 1 : 0; k.lift = k.amb; k.bright = k.st === "idle" ? 0 : 1;
      return k;
    }
    function apply(k, d, fresh) {
      var was = k.st;
      k.label = d.label || "session"; k.st = d.st === "working" || d.st === "waiting" ? d.st : "idle";
      k.kept = d.hired !== true;
      k.menu = !!d.slug; // hired through JOYA AI (kept or not): Keep / Retire in its menu
      k.head = d.head || ""; // core E: the head its role (or the viewer's pin) gives it (JoyaLogic.botHeadFor)
      if (!k.tint) k.tint = d.tint && TINTS[d.tint] ? d.tint : freeTint(d.name || d.label || d.id);
      k.act = Math.max(1, +d.act || 1); k.tok = d.tok || ""; k.tokTip = d.tokTip || ""; k.task = d.task || ""; k.last = d.last || ""; k.mission = d.mission || "";
      if (!fresh && was === "working" && k.st === "idle") { k.bloom = 1; k.doneUntil = t + 3.5; }
      var want = Math.min(6, (d.subs || []).length), alive = k.subs.filter(function (s) { return !s.dying; });
      for (var i = alive.length; i < want; i++) k.subs.push({ ph: rand() * TAU, sp: 0.55 + rand() * 0.5, tilt: 0.25 + rand() * 0.5, dir: rand() < 0.5 ? -1 : 1, life: fresh || reduced ? 1 : 0, dying: false, rr: 1.45 + rand() * 0.3 });
      for (var j = alive.length - 1; j >= want; j--) alive[j].dying = true;
      if (reduced) k.subs = k.subs.filter(function (s) { return !s.dying; });
      var line = k.label + " · " + stText(k) + (want ? " · " + want + (want === 1 ? " sub-agent" : " sub-agents") : "");
      k.el.setAttribute("aria-label", line + ". Open its conversation.");
    }
    /** Its own tint: the one its name hashes to, or the next one no live sphere has (kept while it lives). */
    function freeTint(name) {
      var used = {};
      kids.forEach(function (o) { if (!o.dis && !o.dead && o.tint) used[o.tint] = true; });
      var h = hash(name) % TINT_KEYS.length;
      for (var i = 0; i < TINT_KEYS.length; i++) { var k = TINT_KEYS[(h + i) % TINT_KEYS.length]; if (!used[k]) return k; }
      return TINT_KEYS[h];
    }
    function stText(k) { return k.st === "waiting" ? "waiting on you" : k.st === "working" ? "working" : "idle"; }
    function measure(k) {
      var na = k.subs.filter(function (s) { return !s.dying; }).length;
      var html = esc(k.label) + (k.kept ? "" : '<span class="ht">hired</span>') + '<span class="st">' + (k.st === "working" ? "<i>working</i>" : esc(stText(k))) + (na ? " · " + na + (na === 1 ? " agent" : " agents") : "") + "</span>";
      if (k._h !== html) { k.elN.innerHTML = html; k._h = html; k.lw = Math.max(60, k.elN.offsetWidth || k.lw); }
    }

    /** The live sessions: [{id, label, st, subs, act, tok, tokTip, task, last, mission, hired?, slug?, tint?}]. */
    function setNodes(list) {
      var byId = {};
      kids.forEach(function (k) { if (!k.dis) byId[k.id] = k; });
      var seen = {}, born = [];
      (list || []).forEach(function (d) {
        seen[d.id] = true;
        var k = byId[d.id];
        if (k) apply(k, d, false);
        else { k = makeKid(d, !first); kids.push(k); born.push(k); }
      });
      kids.forEach(function (k) {
        if (!seen[k.id] && !k.dis && !k.dead) {
          if (reduced) { k.dead = true; } else { k.dis = 0.0001; glow = Math.max(glow, 0.2); k.subs.forEach(function (s) { s.dying = true; }); }
          k.el.setAttribute("tabindex", "-1");
          k.el.setAttribute("aria-hidden", "true");
        }
      });
      kids = kids.filter(function (k) { if (k.dead) { k.el.remove(); return false; } return true; });
      if (first) { first = false; computeLayout(); placeAll(); }
      else born.forEach(function (k) { var sp = freeSpot(); k.x = sp.x; k.y = sp.y; k.r = kidTargetR(k); measure(k); });
      if (reduced) settle(160);
      draw();
    }

    /* ---------------------------------------------------------- streams */
    function kidPos(k) { return { x: k.x, y: k.y - 8 * k.lift, r: k.r * (1 + 0.12 * k.hover + 0.07 * k.lift + 0.18 * Math.sin(Math.min(1, k.bloom) * PI)) }; }
    function streamPos(pt) {
      if (pt.k2) return linkPos(pt);
      var k = pt.k, kp = kidPos(k), p = pt.p;
      var dx = kp.x - L.cx, dy = kp.y - L.cy, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl, nx = -uy, ny = ux;
      var hx = L.cx + ux * L.R * 0.9 + nx * pt.jx * L.R * 0.35, hy = L.cy + uy * L.R * 0.9 + ny * pt.jx * L.R * 0.35;
      var cx_ = kp.x - ux * kp.r * 0.7 + nx * pt.jx * kp.r * 0.5, cy_ = kp.y - uy * kp.r * 0.7 + ny * pt.jx * kp.r * 0.5;
      var sx, sy, ex, ey; if (pt.kind === "del") { sx = hx; sy = hy; ex = cx_; ey = cy_; } else { sx = cx_; sy = cy_; ex = hx; ey = hy; }
      var bend = (pt.kind === "del" ? 0.14 : -0.1) * dl + pt.jx * 50;
      var mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
      var u = 1 - p, x = u * u * sx + 2 * u * p * mx + p * p * ex, y = u * u * sy + 2 * u * p * my + p * p * ey;
      var wob = Math.sin(p * PI * 3 + pt.w) * (pt.kind === "del" ? 7 : 3) * Math.sin(p * PI);
      return [x + nx * wob, y + ny * wob];
    }
    /** A hand-off between two sessions (the day replay, cc-story.js): from one head's rim to the other's. */
    function linkPos(pt) {
      var a = kidPos(pt.k2), b = kidPos(pt.k), p = pt.p;
      var dx = b.x - a.x, dy = b.y - a.y, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl, nx = -uy, ny = ux;
      var sx = a.x + ux * a.r * 0.8 + nx * pt.jx * a.r * 0.4, sy = a.y + uy * a.r * 0.8 + ny * pt.jx * a.r * 0.4;
      var ex = b.x - ux * b.r * 0.75 + nx * pt.jx * b.r * 0.4, ey = b.y - uy * b.r * 0.75 + ny * pt.jx * b.r * 0.4;
      var bend = 0.16 * dl + pt.jx * 40, mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
      var u = 1 - p, x = u * u * sx + 2 * u * p * mx + p * p * ex, y = u * u * sy + 2 * u * p * my + p * p * ey;
      var wob = Math.sin(p * PI * 3 + pt.w) * 5 * Math.sin(p * PI);
      return [x + nx * wob, y + ny * wob];
    }
    function linkStream(a, b) {
      if (reduced) { b.catchK = 1; a.glow = 1; draw(); return; }
      for (var i = 0; i < 70; i++) parts.push({ kind: "lnk", k: b, k2: a, t0: t + (i / 70) * 1.4 + rand() * 0.05, dur: 1.3 * (0.85 + rand() * 0.3), jx: (rand() - 0.5) * 0.7, w: rand() * TAU, p: 0, big: rand() < 0.2 });
    }
    function stream(kind, k, count, spread, dur) {
      if (reduced) { if (kind === "del") k.catchK = 1; else k.glow = 1; draw(); return; }
      for (var i = 0; i < count; i++) parts.push({ kind: kind, k: k, t0: t + (i / count) * spread + rand() * 0.05, dur: dur * (0.85 + rand() * 0.3), jx: (rand() - 0.5) * (kind === "del" ? 0.9 : 0.3), w: rand() * TAU, p: 0, big: rand() < 0.2 });
    }
    function find(id) { for (var i = 0; i < kids.length; i++) if (kids[i].id === id && !kids[i].dis) return kids[i]; return null; }
    /**
     * A delegation whose target has no sphere here: the dots still land somewhere real -- a small
     * marker at the scene's edge, named "<name> · Remote / offline / sub-agent", that flashes and fades.
     */
    function ghost(name, where) {
      // The first free spot down the scene's right edge (clear of the spheres, their names and other markers).
      var x = Math.max(90, (L.sceneR || W) - 120), y = (L.top || 60) + 96, tries = 0;
      var clear = function (yy) {
        return kids.every(function (k) { if (k.dead || k.dis) return true; var p = kidPos(k); return Math.hypot(p.x - x, p.y - yy) > p.r * 1.3 + 70; }) &&
          ghosts.every(function (o) { return Math.abs(o.y - yy) > 54; });
      };
      while (!clear(y) && tries++ < 12) y += 54;
      if (tries > 12) y = (L.top || 60) + 96;
      var el = document.createElement("div");
      el.className = "cc-kid cc-ghost";
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = '<span class="nm">' + esc(name || "a session") + '<span class="st">' + esc(where || "not here") + "</span></span>";
      labels.appendChild(el);
      var gk = { ghost: true, id: "ghost:" + (name || ""), x: x, y: y, r: 11, lift: 0, hover: 0, bloom: 0, tint: "blue", age: 0, dead: false, glow: 1, catchK: 0, el: el, elN: el.firstChild };
      ghosts.push(gk);
      if (reduced) gk.catchK = 1; else stream("del", gk, 60, 1.2, 1.2);
      placeGhost(gk);
      if (reduced) { draw(); setTimeout(function () { gk.dead = true; el.remove(); ghosts = ghosts.filter(function (x) { return x !== gk; }); draw(); }, 4200); }
      return gk;
    }
    function ghostAlpha(gk) { return gk.age < 0.25 ? gk.age / 0.25 : gk.age > 3.2 ? Math.max(0, 1 - (gk.age - 3.2) / 0.9) : 1; }
    function placeGhost(gk) {
      gk.el.style.transform = "translate(" + gk.x.toFixed(1) + "px," + gk.y.toFixed(1) + "px)";
      gk.el.style.opacity = (reduced ? 1 : ghostAlpha(gk)).toFixed(2);
      gk.elN.style.top = (gk.r * 1.2 + 10) + "px";
    }

    /* ---------------------------------------------------------- per frame */
    function update(dt) {
      lastFrame = Date.now();
      t += dt;
      if (t - rectsAt > 0.25) { rectsAt = t; computeLayout(); refreshRects(); }
      glow *= Math.exp(-dt * 1.6);
      physics(dt);
      var hk = null;
      if (mouse.over && !phone && !document.querySelector(".cc-smenu, .cc-sdlg-back")) hk = hit(mouse.x, mouse.y); // no hover card under a sphere's menu
      if (hk !== hoverKid) { hoverKid = hk; if (hk) showCard(hk); else hideCard(); els.root.classList.toggle("kid-hover", !!hk); }
      if (hoverKid) placeCard(hoverKid);
      for (var j = kids.length - 1; j >= 0; j--) {
        var k = kids[j], e = 1 - Math.exp(-dt * 3);
        if (!k.dis) k.r += (kidTargetR(k) - k.r) * (1 - Math.exp(-dt * 1.2));
        k.hover += ((k === hoverKid ? 1 : 0) - k.hover) * (1 - Math.exp(-dt * 8));
        k.amb += ((k.st === "waiting" ? 0.92 : 0) - k.amb) * (1 - Math.exp(-dt * 1.8));
        k.lift += ((k.st === "waiting" ? 1 : 0) - k.lift) * (1 - Math.exp(-dt * 1.5));
        k.bright += ((k.st === "idle" ? 0 : 1) - k.bright) * e;
        k.catchK *= Math.exp(-dt * 2.2); k.glow *= Math.exp(-dt * 1.5);
        k.bloom = Math.max(0, k.bloom - dt * 0.7);
        k.rot += dt * (0.12 + 0.55 * (k.st === "working" ? 1 : 0) + 0.12 * (k.st === "waiting" ? 1 : 0));
        k.fold += dt * (0.05 + 0.25 * (k.st === "working" ? 1 : 0));
        if (k.form < 1) k.form = Math.min(1, k.form + dt / 2.6);
        if (k.dis > 0) {
          k.dis += dt / 3.0;
          if (k.dis >= 1) { k.dead = true; glow = 1; k.el.remove(); kids.splice(j, 1); continue; }
          if (k.dis > 0.55) glow = Math.max(glow, (k.dis - 0.55) * 1.6);
        }
        for (var s = k.subs.length - 1; s >= 0; s--) { var sb = k.subs[s]; if (sb.dying) { sb.life -= dt / 1.4; if (sb.life <= 0) k.subs.splice(s, 1); } else sb.life = Math.min(1, sb.life + dt / 1.2); }
      }
      for (var gi = ghosts.length - 1; gi >= 0; gi--) {
        var gk = ghosts[gi];
        gk.age += dt; gk.catchK *= Math.exp(-dt * 2.2);
        if (gk.age > 4.1) { gk.dead = true; gk.el.remove(); ghosts.splice(gi, 1); }
      }
      for (var q = parts.length - 1; q >= 0; q--) {
        var pt = parts[q]; pt.p = (t - pt.t0) / pt.dur;
        if (pt.p >= 1 || pt.k.dead || (pt.k2 && pt.k2.dead)) { if (pt.kind === "del" || pt.kind === "lnk") pt.k.catchK = Math.min(1, pt.k.catchK + 0.06); parts.splice(q, 1); }
      }
    }

    /* ---------------------------------------------------------- render */
    function drawSphere(P, o) {
      var n = P.n, dir = P.dir, rnd = P.rnd, cr = Math.cos(o.rot), sr = Math.sin(o.rot), ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
      var base = light ? 0.16 : 0.07, R = o.R, tt = o.t, pal = o.pal, amb = o.ambPal, ambK = o.ambK || 0;
      var form = o.form, dis = o.dis || 0, sh = o.shimmer || 0, am = o.alpha;
      for (var i = 0; i < n; i++) {
        var dx = dir[i * 3], dy = dir[i * 3 + 1], dz = dir[i * 3 + 2], r1 = rnd[i * 2], r2 = rnd[i * 2 + 1];
        var r = 1 + o.breath * Math.sin(tt * 1.05 + o.bph) + 0.03 * Math.sin(Math.acos(dy) * 5 + tt * 0.7);
        var X = (cr * dx + sr * dz) * r, Y = dy * r, Z = (-sr * dx + cr * dz) * r;
        var Y2 = Y * ct - Z * st, Z2 = Y * st + Z * ct, persp = 3.3 / (3.3 - Z2);
        var sx = o.cx + X * R * persp, sy = o.cy - Y2 * R * persp;
        var depth = clamp((Z2 + 1.25) / 2.5, 0, 1), gcol = clamp(0.5 + 0.62 * (X * 0.6 + Y2 * 0.6), 0, 1);
        var a = base + (1 - base) * Math.pow(depth, 1.4);
        if (sh > 0) a *= 1 - sh * 0.6 * Math.pow(0.5 + 0.5 * Math.sin(tt * 6.5 + r1 * 60), 3);
        if (form < 1) { // born: dots stream out of her and condense
          var p = ease(clamp((form - r1 * 0.45) / 0.55, 0, 1));
          var fx = L.cx + dx * L.R * 0.8, fy = L.cy - dy * L.R * 0.8;
          var mx = (fx + sx) / 2 + (r2 - 0.5) * 160, my = (fy + sy) / 2 + (r1 - 0.5) * 120, u = 1 - p;
          sx = u * u * fx + 2 * u * p * mx + p * p * sx; sy = u * u * fy + 2 * u * p * my + p * p * sy;
          a = Math.max(a, 0.55) * (0.75 + 0.25 * p) * 1.3;
        }
        if (dis > 0) { // gone: the dust drifts back into her
          var q = ease(clamp((dis - r1 * 0.4) / 0.6, 0, 1));
          var ex = L.cx + dx * L.R * 0.55, ey = L.cy - dy * L.R * 0.55, sw = Math.sin(q * PI) * (r2 - 0.5) * 220;
          var cx2 = (sx + ex) / 2 + sw, cy2 = (sy + ey) / 2 + (r1 - 0.5) * 120, v = 1 - q;
          sx = v * v * sx + 2 * v * q * cx2 + q * q * ex; sy = v * v * sy + 2 * v * q * cy2 + q * q * ey;
          a *= 1 - q * 0.9;
        }
        g.globalAlpha = a * am > 1 ? 1 : a * am;
        g.fillStyle = amb && r1 < ambK ? amb[(gcol * 31) | 0] : pal[(gcol * 31) | 0];
        var sz = o.size * (0.6 + 1.2 * depth * depth) * persp;
        if (form < 1) sz *= 1 + 0.9 * (1 - form);
        g.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
      }
      g.globalAlpha = 1;
    }
    function draw() {
      if (!W) return;
      if (mesh && reduced && opts.meshRedraw) opts.meshRedraw();
      var c = light ? C.light : C.dark;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, W, H);
      if (glow > 0.02) {
        var hg = g.createRadialGradient(L.cx, L.cy, L.R * 0.4, L.cx, L.cy, L.R * 1.4);
        hg.addColorStop(0, rgba(c.joya, 0.10 * glow)); hg.addColorStop(1, rgba(c.vio, 0));
        g.fillStyle = hg; g.fillRect(L.cx - L.R * 1.5, L.cy - L.R * 1.5, L.R * 3, L.R * 3);
      }
      for (var q = 0; q < parts.length; q++) {
        var pt = parts[q]; if (pt.p <= 0) continue;
        var tp = PAL[pt.k.tint];
        for (var tr = 0; tr < 3; tr++) {
          var pp = pt.p - tr * 0.018; if (pp <= 0) continue;
          var save = pt.p; pt.p = pp; var xy = streamPos(pt); pt.p = save;
          g.globalAlpha = (0.9 - tr * 0.3) * Math.min(1, pp * 6) * (pt.kind === "rep" ? 0.85 : 1);
          g.fillStyle = pt.kind === "lnk" ? (pp < 0.5 ? PAL[pt.k2.tint][16] : tp[14]) : pt.kind === "del" ? (pp < 0.6 ? PAL.main[4 + ((pp * 16) | 0)] : tp[14]) : pp < 0.5 ? tp[16] : PAL.main[20];
          var s = (pt.big ? 2.8 : 1.9) * (1 - tr * 0.25);
          g.fillRect(xy[0] - s / 2, xy[1] - s / 2, s, s);
        }
      }
      g.globalAlpha = 1;
      kids.forEach(function (k) { drawKid(k, c); });
      kids.forEach(place);
      ghosts.forEach(function (gk) {
        var a = reduced ? 1 : ghostAlpha(gk), fl = Math.min(1, gk.catchK * 3);
        g.globalAlpha = a * (0.55 + 0.45 * fl);
        g.strokeStyle = PAL.blue[18];
        g.lineWidth = 1.5;
        g.setLineDash([3, 4]);
        g.beginPath(); g.arc(gk.x, gk.y, gk.r * (1 + 0.35 * fl), 0, TAU); g.stroke();
        g.setLineDash([]);
        g.globalAlpha = a * (0.35 + 0.65 * fl);
        g.fillStyle = PAL.blue[20];
        g.beginPath(); g.arc(gk.x, gk.y, 3 + 3 * fl, 0, TAU); g.fill();
        g.globalAlpha = 1;
        placeGhost(gk);
      });
    }
    function drawKid(k, c) {
      var p = kidPos(k), r = p.r, fade = k.form < 1 ? k.form : 1;
      var alpha = (light ? 0.62 : 0.5) + (1 - (light ? 0.62 : 0.5)) * k.bright + 0.5 * k.catchK + 0.35 * k.glow + 0.5 * k.bloom + 0.2 * k.hover;
      var pulse = k.amb > 0.05 && !reduced ? 0.5 + 0.5 * Math.sin(t * 2.6) : 0.5;
      if (k.amb > 0.05 && !k.dis) {
        var ag = g.createRadialGradient(p.x, p.y, r * 0.6, p.x, p.y, r * 2.1);
        ag.addColorStop(0, rgba(c.amb, (light ? 0.14 : 0.2) * k.amb * (0.6 + 0.4 * pulse))); ag.addColorStop(1, rgba(c.amb, 0));
        g.fillStyle = ag; g.fillRect(p.x - r * 2.2, p.y - r * 2.2, r * 4.4, r * 4.4);
      }
      if (k.kept && !k.dis) {
        g.strokeStyle = rgba(c.ring, (light ? 0.55 : 0.6) * fade); g.lineWidth = 1.2;
        g.beginPath(); g.ellipse(p.x, p.y + r * 1.02, r * 0.74, r * 0.13, 0, 0, TAU); g.stroke();
      }
      if (k.bloom > 0) { g.strokeStyle = rgba(c.joya, 0.6 * k.bloom); g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, r * (1.05 + (1 - k.bloom) * 0.9), 0, TAU); g.stroke(); }
      subs(k, p, -1);
      if (!mesh) drawSphere(PC, {
        cx: p.x, cy: p.y, R: r * (1 + 0.035 * pulse * k.amb), rot: k.rot, tilt: 0.3 + 0.12 * k.lift, t: t + k.ph[0] * 3, pal: PAL[k.tint], ambPal: PAL.amb, ambK: k.amb,
        size: 1.35 * clamp(r / 32, 0.8, 1.35), alpha: alpha, shimmer: k.st === "working" && !reduced ? 1 : 0, breath: reduced ? 0 : 0.03, bph: k.ph[1], form: k.form, dis: k.dis,
      });
      subs(k, p, 1);
    }
    function subs(k, p, side) {
      if (!k.subs.length) return;
      var pal = PAL[k.tint];
      k.subs.forEach(function (s) {
        var a = s.ph + t * s.sp * s.dir, z = Math.sin(a);
        if ((z > 0 ? 1 : -1) !== side) return;
        var x = p.x + Math.cos(a) * p.r * s.rr, y = p.y + Math.sin(a) * Math.sin(s.tilt) * p.r * s.rr * 0.45 - Math.cos(a) * p.r * 0.18;
        var al = ease(clamp(s.life, 0, 1)) * (z > 0 ? 1 : 0.4) * (1 - k.dis);
        g.globalAlpha = al * 0.25; g.fillStyle = pal[26]; g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill();
        g.globalAlpha = al; g.fillStyle = pal[22]; g.beginPath(); g.arc(x, y, 2.8, 0, TAU); g.fill();
        for (var i = 1; i < 5; i++) {
          var a2 = a - s.dir * i * 0.09, x2 = p.x + Math.cos(a2) * p.r * s.rr, y2 = p.y + Math.sin(a2) * Math.sin(s.tilt) * p.r * s.rr * 0.45 - Math.cos(a2) * p.r * 0.18;
          g.globalAlpha = al * (0.5 - i * 0.1); g.fillRect(x2 - 0.8, y2 - 0.8, 1.6, 1.6);
        }
      });
      g.globalAlpha = 1;
    }
    function place(k) {
      var p = kidPos(k), vis = (k.form < 1 ? ease(k.form) : 1) * (1 - Math.min(1, k.dis * 2.5));
      k.el.style.transform = "translate(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px)";
      k.el.style.opacity = vis.toFixed(2);
      measure(k);
      k.elN.style.top = (p.r * 1.2 + 10) + "px";
      k.el.style.setProperty("--kid-r", p.r.toFixed(1) + "px");
      var badge = k.st === "waiting" ? "needs you" : t < k.doneUntil ? "done" : "";
      if (k.badge !== badge) {
        k.badge = badge;
        if (badge) k.elB.textContent = badge;
        k.elB.classList.toggle("done", badge === "done");
        k.elB.classList.toggle("on", !!badge);
      }
      k.elB.style.top = (-p.r - 12) + "px";
    }

    /* ---------------------------------------------------------- hover + click */
    function hit(mx, my) {
      var best = null, bd = 1e9;
      kids.forEach(function (k) {
        if (k.dead || k.dis || k.form < 0.9) return;
        var p = kidPos(k), d = Math.hypot(mx - p.x, my - p.y);
        if (d < p.r * 1.25 + 8 && d < bd) { bd = d; best = k; }
      });
      return best;
    }
    function pill(k) { return k.st === "waiting" ? '<span class="cc-kpill needs">Needs you</span>' : k.st === "working" ? '<span class="cc-kpill">Working</span>' : '<span class="cc-kpill idle">Idle</span>'; }
    function showCard(k) {
      if (!card) return;
      var na = k.subs.filter(function (s) { return !s.dying; }).length;
      card.innerHTML = '<h4><span class="sw ' + k.tint + '"></span>' + esc(k.label) + ' <span class="cc-ktag' + (k.kept ? " kept" : "") + '">' + (k.kept ? "Kept" : "Hired") + "</span></h4>" +
        "<dl><dt>State</dt><dd>" + pill(k) + (na ? ' <span class="cc-kmuted">+' + na + (na === 1 ? " sub-agent" : " sub-agents") + "</span>" : "") + "</dd>" +
        "<dt>Now</dt><dd>" + esc(k.task || "Nothing running") + "</dd>" +
        (k.last ? '<dt>Last</dt><dd class="q">“' + esc(k.last) + "”</dd>" : "") +
        "<dt>Today</dt><dd" + (k.tokTip ? ' title="' + esc(k.tokTip) + '"' : "") + ">" + esc(k.tok || "—") + "</dd></dl>" +
        '<div class="hint">Click to open the conversation' + (k.menu ? " · right-click: Keep / Retire" : "") + "</div>";
      card.classList.add("on");
      card.setAttribute("aria-hidden", "false");
    }
    function hideCard() { if (card) { card.classList.remove("on"); card.setAttribute("aria-hidden", "true"); } }
    function placeCard(k) {
      if (!card) return;
      var p = kidPos(k), cw = 290, ch = card.offsetHeight || 170, right = p.x >= L.cx;
      var x = right ? p.x + p.r * 1.3 + 22 : p.x - p.r * 1.3 - 22 - cw;
      if (x + cw > L.sceneR - 12) x = p.x - p.r * 1.3 - 22 - cw;
      if (x < 12) x = p.x + p.r * 1.3 + 22;
      card.style.left = x.toFixed(0) + "px";
      card.style.top = clamp(p.y - ch / 2 - 10, L.top + 8, H - ch - 100).toFixed(0) + "px";
    }
    var UI = "button, a, input, textarea, select, form, label, .cc-sheet, .cc-need, .cc-pop, .cc-reply, .cc-rail, .topbar, .cc-dock, .cc-caption, [role=dialog], [role=alertdialog], #cc-ov, [data-cc-obstacle]";
    function uiTarget(el) { return !!(el && el.closest && el.closest(UI)); }
    var lastFrame = 0; // no frames (reduced motion, or the desktop app's still core): hover is worked out on the move itself
    document.addEventListener("pointermove", function (e) { if (!on) return; mouse.x = e.clientX; mouse.y = e.clientY; mouse.over = !uiTarget(e.target); if (reduced || Date.now() - lastFrame > 250) { var hk = mouse.over && !phone ? hit(mouse.x, mouse.y) : null; if (hk !== hoverKid) { hoverKid = hk; if (hk) { showCard(hk); placeCard(hk); } else hideCard(); els.root.classList.toggle("kid-hover", !!hk); } } });
    document.addEventListener("pointerleave", function () { mouse.over = false; });
    document.addEventListener("click", function (e) {
      if (!on) return;
      var b = e.target && e.target.closest ? e.target.closest("[data-kid]") : null;
      if (b) { if (opts.onClick) opts.onClick(b.getAttribute("data-kid")); return; } // Enter / Space on a name
      if (uiTarget(e.target)) return;
      var k = hit(e.clientX, e.clientY);
      if (k && opts.onClick) { hideCard(); opts.onClick(k.id); }
    });

    document.addEventListener("contextmenu", function (e) {
      if (!on || !opts.onMenu) return;
      var b = e.target && e.target.closest ? e.target.closest("[data-kid]") : null;
      var id = b ? b.getAttribute("data-kid") : null;
      if (!id && !uiTarget(e.target)) { var k = hit(e.clientX, e.clientY); if (k) id = k.id; }
      if (!id) return;
      e.preventDefault();
      hideCard(); mouse.over = false;
      if (!b || e.clientX || e.clientY) return opts.onMenu(id, e.clientX, e.clientY);
      var r = b.getBoundingClientRect();
      opts.onMenu(id, r.left + r.width / 2, r.bottom);
    });

    function frame() {
      if (!on || reduced) return;
      var now = performance.now();
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      if (last) { iv.push(now - last); if (iv.length > 300) iv.shift(); }
      last = now;
      var t0 = performance.now();
      update(dt);
      draw();
      cost.push(performance.now() - t0); if (cost.length > 300) cost.shift();
    }

    buildPalettes();
    return {
      TINTS: TINTS,
      setNodes: setNodes,
      frame: frame,
      draw: draw,
      resize: resize,
      /** Core D draws the spheres as meshes (true), or this canvas draws the dotted ones (false). */
      setMesh: function (yes) { mesh = !!yes; draw(); },
      /**
       * For core D: each sphere this frame, in CSS px -- position, size, tint (dark and light), how
       * bright (idle dims, a delegation landing brightens), shimmer (working: faster folds, brighter rim),
       * amber (waiting on you, pulsing), and its birth / dissolve progress.
       */
      meshKids: function () {
        if (!on || !mesh) return null;
        var out = [], pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.6);
        kids.forEach(function (k) {
          if (k.dead) return;
          var p = kidPos(k), tc = TINTS[k.tint] || TINTS.teal;
          var alpha = (light ? 0.62 : 0.5) + (1 - (light ? 0.62 : 0.5)) * k.bright + 0.35 * k.glow + 0.5 * k.bloom + 0.2 * k.hover;
          out.push({
            x: p.x, y: p.y, r: p.r * (1 + 0.035 * pulse * k.amb), alpha: alpha * 0.85,
            rot: k.rot, phase: k.ph[0] + k.fold,
            amb: k.amb * (0.55 + 0.45 * pulse), shimmer: k.st === "working" && !reduced ? 1 : 0,
            form: k.form, dis: k.dis || 0, catchK: Math.min(1, k.catchK * 1.4), seed: k.ph[2],
            tint: tc.dark, tintL: tc.light,
            // core E (bot heads): which session, its state and what just happened, for the face (JoyaLogic.botSessState)
            key: k.id, st: k.st, glow: k.glow, bloom: k.bloom, head: k.head,
          });
        });
        return out;
      },
      /** Spheres on (true) or the classic orbit (false). */
      enable: function (yes) {
        on = !!yes;
        cv.hidden = !on; labels.hidden = !on;
        if (!on) { hideCard(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); }
        else resize();
      },
      enabled: function () { return on; },
      setLight: function (l) { light = !!l; buildPalettes(); draw(); },
      send: function (id) { var k = find(id); if (k) stream("del", k, 90, 1.5, 1.35); return !!k; },
      /** No sphere for this target: stream to a marker at the edge ("<name> · Remote"), which flashes and fades. */
      ghost: function (name, where) { return !!ghost(name, where); },
      ghosts: function () { return ghosts.map(function (gk) { return { name: gk.el.querySelector(".nm").firstChild.textContent, where: gk.el.querySelector(".st").textContent, x: gk.x, y: gk.y }; }); },
      reply: function (id) { var k = find(id); if (k) { k.glow = 1; stream("rep", k, 60, 1.6, 1.25); } return !!k; },
      /** A hand-off from one session to another (both spheres here): a stream of dots between the two heads. */
      link: function (fromId, toId) { var a = find(fromId), b = find(toId); if (a && b && a !== b) { a.glow = 1; linkStream(a, b); return true; } return false; },
      positions: function () { var o = {}; kids.forEach(function (k) { if (!k.dis) { var p = kidPos(k); o[k.id] = [p.x, p.y]; } }); return o; },
      /** Checks: sphere/name boxes that overlap her, each other or the chrome (should be none). */
      audit: function () {
        refreshRects();
        var bad = [], ks = kids.filter(function (k) { return !k.dead && k.form >= 1 && !k.dis; });
        ks.forEach(function (k, i) {
          var p = kidPos(k), bx = kidBox(k, p.x, p.y);
          rects.forEach(function (rc, j) { if (pen(bx, rc, -2)) bad.push(k.label + " x " + (rc.name || "rect" + j)); });
          if (Math.hypot(p.x - L.cx, p.y - L.cy) < L.R + p.r - 2) bad.push(k.label + " x JOYA AI");
          ks.forEach(function (q, j) { if (j <= i) return; var qp = kidPos(q); if (Math.hypot(p.x - qp.x, p.y - qp.y) < p.r + qp.r) bad.push(k.label + " x " + q.label); });
          if (p.x - p.r < 0 || p.x + p.r > W || p.y - p.r < 0 || p.y + p.r > H) bad.push(k.label + " off screen");
          if (L.floor < H && p.y + p.r > L.floor) bad.push(k.label + " below the message bar");
        });
        return bad;
      },
      stats: function () {
        var a = cost.slice().sort(function (x, y) { return x - y; }), b = iv.slice().sort(function (x, y) { return x - y; });
        if (!a.length || !b.length) return null;
        var med = function (v) { return v[Math.floor(v.length / 2)]; }, p95 = function (v) { return v[Math.floor(v.length * 0.95)]; };
        return { n: a.length, jsMedian: +med(a).toFixed(2), jsP95: +p95(a).toFixed(2), frameMedian: +med(b).toFixed(2), fps: +(1000 / med(b)).toFixed(1) };
      },
      resetStats: function () { cost = []; iv = []; },
      kids: function () { return kids.map(function (k) { var p = kidPos(k); return { id: k.id, label: k.label, st: k.st, x: p.x, y: p.y, r: p.r, kept: k.kept, hired: !k.kept, tint: k.tint, subs: k.subs.filter(function (s) { return !s.dying; }).length, form: k.form, dis: k.dis, badge: k.badge }; }); },
      layout: function () { return { cx: L.cx, cy: L.cy, R: L.R }; },
    };
  };
})();
