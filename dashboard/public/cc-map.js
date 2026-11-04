"use strict";
/*
 * The Command Center's stage: the JOYA AI core in the middle and the live
 * sessions round it.
 *
 * The core's concept (D mesh, the default -- joya-core-d.js; E bot --
 * joya-core-bot.js, with the viewer's head style and colours from
 * data-bot-head / data-bot-colors) is the viewer's saved choice, rendered by
 * the server as data-core on #cc before first paint and switchable at any time
 * without a reload (setConcept). The cores A, B and C (joya-core.js) were
 * retired on 2026-10-25. Crossing between D and E stops the running core,
 * releases its context and starts the other on a fresh copy of the canvas. Its state comes
 * from real events through joya-ai.js: thinking while a turn runs, delegating
 * when a SendMessage lands (a stream of dots flies to that session's point),
 * listening with the real microphone level, speaking with the real output
 * level of the voice, needs-you while something waits for a decision.
 *
 * Session points: working ones breathe, waiting ones are amber, idle ones
 * grey; hovering shows the name, a click opens the Sessions sheet. A reply
 * from a session flashes its point. Positions are set through element.style
 * (CSSOM), never a style attribute: the CSP refuses those.
 *
 * The sessions view is the viewer's choice (data-sessview on #cc): "spheres"
 * (the default) hands the sessions to the family of spheres (cc-family.js),
 * drawn on its own canvas on the core's frame; "orbit" keeps the classic dots.
 * Either way delegations and replies arrive here and are forwarded.
 *
 * Exposes one factory, window.JoyaMap(els, opts), used by joya-ai.js. The name
 * is the v3 map's, kept so the page's calls (setNodes, send, reply, setState,
 * micSource, outSource, palette, resize, start) read the same.
 */
(function () {
  window.JoyaMap = function (els, opts) {
    opts = opts || {};
    var root = els.root, stage = els.stage, orbit = els.orbit, ring = els.ring, halo = els.halo;
    var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var L = { cx: 0, cy: 0, R: 200, rx: 300, ry: 80 };
    var nodes = [];          // {id, label, st, subs, el}
    var pos = {};            // id -> [x, y] in CSS pixels
    var target = null, lastTarget = null, targetTimer = 0;
    var lastPos = {};        // a sphere's last position (a stream keeps its aim if she dissolves mid-beam)
    var ghostAt = null;      // the edge marker for a target with no sphere
    var micLevel = null, outLevel = null, outSpec = null;
    var state = "idle";

    var GHOST = "\u0000ghost";
    function normC(c) { return window.JoyaLogic ? window.JoyaLogic.normCore(c) : String(c == null ? "" : c).trim().toUpperCase(); }
    /** Which renderer draws a concept: "D" (joya-core-d.js) or "E" (joya-core-bot.js); a missing one stands in for the other. */
    function rendererOf(c) { c = normC(c); return c === "E" ? (window.JoyaCoreBot ? "E" : "D") : window.JoyaCoreD ? "D" : "E"; }
    /** D and E draw the family's spheres themselves (as meshes / bot heads), on their own canvas. */
    function drawsKids() { return core.S.concept === "D" || core.S.concept === "E"; }
    function botHead() { return root.getAttribute("data-bot-head") || ""; }
    function botColors() { var L = window.JoyaLogic; return L ? L.normBotColors(root.getAttribute("data-bot-colors") || "") : null; }
    /** JOYA AI's sounds (joya-sound.js): every core plays them; the bot (E) also shows the reaction. */
    function sound(name, role) { var M = window.JoyaSound; if (M && M.play) M.play(name, { role: role }); }
    function coreOpts(c) {
      return {
        concept: c,
        points: window.innerWidth <= 720 ? 2600 : 4200,
        dest: function () { return aimPoint(); },
        amp: function (st) {
          if (st === "listening" && micLevel) return Math.min(1, micLevel() * 7);
          if (st === "speaking" && outLevel) {
            var v = outLevel();
            return v < 0 ? null : Math.min(1, v * 4.5);
          }
          return null;
        },
        // E: the mouth takes its shape from the voice's spectrum (outSpectrum); the eyes follow the pointer
        spec: function () { return outSpec ? outSpec() : null; },
        pointer: true,
        onFrame: onFrame,
        backdrop: "glow", // D / E: only the glow round the core; the page keeps its own background
        head: botHead(), colors: botColors(), // E: the viewer's bot
        onWake: function () { sound("wake", "core"); }, // E: a dozing bot woke: its chirp
        desk: document.documentElement.classList.contains("cc-desk"), // E: the desktop app (over the wallpaper): backplates, a stronger wireframe
        // D draws the family's spheres as meshes on its own canvas, after the family has moved this frame.
        kids: function () { return family && family.enabled() ? family.meshKids() : null; },
        beforeDraw: function () { if (family && family.enabled()) family.frame(); },
      };
    }
    function makeCore(c) {
      var r = rendererOf(c);
      var k = r === "D" ? window.JoyaCoreD(els.canvas, coreOpts("D")) : window.JoyaCoreBot(els.canvas, coreOpts("E"));
      if (r === "E" && offline && k.setOffline) k.setOffline(true);
      els.canvas = k.canvas || els.canvas; // a core that fell back to 2D drew on a fresh copy of the canvas
      return k;
    }
    var core = makeCore(root.getAttribute("data-core"));
    var offline = false;
    /** Hand the canvas to another renderer (D / E): stop, release the context, fresh canvas, same state. */
    function swapCore(c) {
      var wasOn = !!(core.S.running || core.S.wanted);
      core.stop();
      if (core.destroy) core.destroy();
      else {
        try { var g1 = els.canvas.getContext("webgl"), lc = g1 && g1.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); } catch (e) { /* no context to give back */ }
      }
      var fresh = els.canvas.cloneNode(false);
      els.canvas.parentNode.replaceChild(fresh, els.canvas);
      els.canvas = fresh;
      core = makeCore(c);
      root.classList.toggle("core-2d", !core.isGL);
      meshFamily();
      palette();
      core.setState(state);
      resize();
      if (wasOn) core.start();
    }
    /** Where the delegation stream flies. */
    function aimPoint() {
        var id = target || lastTarget;
        if (family && family.enabled()) {
          // Spheres: only a sphere (or her last place, if she dissolved mid-beam) or the edge marker --
          // never the hidden orbit's dots or a fixed point in empty space.
          if (id === GHOST && ghostAt) return ghostAt;
          var fp = family.positions();
          if (id && fp[id]) { lastPos[id] = fp[id]; return fp[id]; }
          if (id && lastPos[id]) return lastPos[id];
          return [L.cx, L.cy];
        }
        if (id && pos[id]) return pos[id];
        var first = nodes[0] && pos[nodes[0].id];
        return first || [L.cx + L.rx * 0.8, L.cy - L.ry * 1.6];
    }
    root.classList.toggle("core-2d", !core.isGL);

    /* ---------------------------------------------------------- the family of spheres */
    function vis(el) { return el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none"; }
    function box(el, pad, name) { var r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; return { l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad, name: name }; }
    /** What the spheres must stay clear of: every piece of chrome that is showing. */
    function obstacles() {
      var out = [];
      function add(sel, pad, name) { var els_ = document.querySelectorAll(sel); for (var i = 0; i < els_.length; i++) if (vis(els_[i])) { var b = box(els_[i], pad, name); if (b) out.push(b); } }
      add(".topbar", 4, "top bar");
      add("#cc-cap-state, #cc-cap, #cc-cap-more", 10, "caption");
      add("#cc-compose, #cc-voicebar, #cc-hint", 10, "composer");
      add("#cc-need", 10, "approval card");
      add("#cc-rail", 8, "icon rail");
      add("#cc-reply", 10, "reply");
      add("#cc-pop", 6, "menu");
      add("#cc-offline", 8, "offline note");
      add("[data-cc-obstacle]", 8, "panel"); // e.g. the day timeline (cc-story.js)
      return out;
    }
    function sceneRight() {
      var sh = document.getElementById("cc-sheet");
      if (sh && sh.classList.contains("open") && vis(sh) && window.innerWidth > 720) { var r = sh.getBoundingClientRect(); if (r.width) return Math.max(200, r.left - 8); }
      return window.innerWidth;
    }
    var family = null;
    if (window.JoyaFamily && els.family) {
      family = window.JoyaFamily({ root: root, canvas: els.family, labels: els.kids, card: els.kcard }, {
        layout: function () { return { cx: L.cx, cy: L.cy, R: L.R }; },
        obstacles: obstacles,
        sceneRight: sceneRight,
        top: function () { var tb = document.querySelector(".topbar"); return tb ? tb.getBoundingClientRect().bottom : 60; },
        onClick: function (id) { if (opts.onOpen) opts.onOpen(id); else if (opts.onClick) opts.onClick(id); },
        onMenu: function (id, x, y) { if (opts.onMenu) opts.onMenu(id, x, y); },
        // Reduced motion: the family redraws on a change; the core draws its meshes still.
        meshRedraw: function () { if (drawsKids() && (core.S.still || !core.S.running)) core.draw(); },
      });
    }
    function spheresOn() { return root.getAttribute("data-sessview") !== "orbit"; }
    /** With core D (and WebGL2) the session spheres are meshes the core draws, with E bot heads (its 2D renderer draws them too); else the family's dotted ones. */
    function meshFamily() { if (family) family.setMesh((core.S.concept === "D" && core.isGL) || core.S.concept === "E"); }
    meshFamily();

    function isLight() {
      var t = document.documentElement.getAttribute("data-theme");
      if (t) return t === "light";
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    }
    function palette() { core.setLight(isLight()); if (family) family.setLight(isLight()); }
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      if (mq.addEventListener) mq.addEventListener("change", palette);
    }

    /* ---------------------------------------------------------- layout */
    function resize() {
      var r = stage.getBoundingClientRect();
      var phone = window.innerWidth <= 720;
      // The desktop app's render mode places the core itself (public/joya-desktop-layout.js).
      var ov = opts.layoutOverride ? opts.layoutOverride() : null;
      if (ov && ov.R > 0) {
        L.cx = ov.cx;
        L.cy = ov.cy;
        L.R = ov.R;
      } else {
        if (!r.width || !r.height) return;
        L.cx = r.left + r.width / 2;
        L.cy = r.top + r.height / 2 + (phone ? 4 : 14);
        L.R = Math.max(80, Math.min(r.width * (phone ? 0.34 : 0.36), r.height * 0.36, 275));
        // Phone with the family of spheres (the mockup's phone layout): a smaller core, so the spheres fit round her.
        if (phone && family && spheresOn()) L.R = Math.max(62, Math.min(92, r.width * 0.22, r.height * 0.2));
      }
      L.rx = Math.min(L.R * 1.62, window.innerWidth / 2 - 20);
      L.ry = L.R * 0.34;
      core.resize(L.cx, L.cy, L.R, window.innerWidth, window.innerHeight);
      halo.style.left = L.cx + "px";
      halo.style.top = L.cy + "px";
      halo.style.width = halo.style.height = L.R * 4.2 + "px";
      var e = ring.firstElementChild;
      ring.setAttribute("width", String(window.innerWidth));
      ring.setAttribute("height", String(window.innerHeight));
      e.setAttribute("cx", L.cx.toFixed(1));
      e.setAttribute("cy", L.cy.toFixed(1));
      e.setAttribute("rx", L.rx.toFixed(1));
      e.setAttribute("ry", L.ry.toFixed(1));
      place(core.S.t);
      if (family && family.enabled()) family.resize();
    }
    window.addEventListener("resize", resize);

    /* ---------------------------------------------------------- the orbit */
    function place(t) {
      var n = nodes.length;
      for (var i = 0; i < n; i++) {
        var nd = nodes[i];
        var a = -0.9 + (i * Math.PI * 2) / n + (reduced ? 0 : t * 0.045);
        var x = L.cx + L.rx * Math.cos(a), y = L.cy + L.ry * Math.sin(a);
        var front = Math.sin(a) * 0.5 + 0.5;
        pos[nd.id] = [x, y];
        nd.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) scale(" + (0.8 + 0.3 * front).toFixed(3) + ")";
        nd.el.style.opacity = (0.45 + 0.55 * front).toFixed(2);
        nd.el.style.zIndex = front > 0.5 ? "4" : "2";
      }
    }
    function stLabel(st) { return st === "working" ? "working" : st === "waiting" ? "waiting on you" : st === "offline" ? "offline" : "idle"; }
    function setNodes(list) {
      var old = {};
      nodes.forEach(function (n) { old[n.id] = n; });
      var next = (list || []).map(function (s) {
        var n = old[s.id];
        if (!n) {
          var el = document.createElement("button");
          el.type = "button";
          el.className = "cc-sess";
          el.setAttribute("data-node", s.id);
          el.innerHTML = '<i></i><span class="nm"></span>';
          orbit.appendChild(el);
          n = { id: s.id, el: el };
        }
        delete old[s.id];
        n.label = s.label; n.st = s.st; n.subs = s.subs || []; n.mission = !!s.mission;
        var cls = s.st === "working" ? "work" : s.st === "waiting" ? "wait" : "idle";
        n.el.className = "cc-sess " + cls + (n.mission ? " mis" : "") + (n.id === target ? " target" : "") + (n.subs.length ? " subs" : "");
        var line = s.label + " · " + stLabel(s.st) + (n.subs.length ? " · " + n.subs.length + " sub-agent" + (n.subs.length === 1 ? "" : "s") : "");
        n.el.querySelector(".nm").textContent = line;
        n.el.setAttribute("aria-label", line + ". Open the sessions sheet.");
        n.el.setAttribute("data-subs", String(Math.min(n.subs.length, 9)));
        return n;
      });
      Object.keys(old).forEach(function (k) { old[k].el.remove(); delete pos[k]; });
      nodes = next;
      botNotice(list || []);
      place(core.S.t);
      if (family) family.setNodes(list || []);
    }
    orbit.addEventListener("click", function (e) {
      var b = e.target.closest("[data-node]");
      if (b && opts.onClick) opts.onClick(b.getAttribute("data-node"));
    });

    /* ---------------------------------------------------------- per frame */
    function onFrame(S, W) {
      if (!reduced) place(S.t);
      if (family && family.enabled() && !drawsKids()) family.frame(); // D / E moved it before drawing (beforeDraw)
      if (opts.onFrame) opts.onFrame(S, W);
      if (sampler) { var f = sampler; sampler = null; f(core.canvas); }
    }
    var sampler = null;

    /*
     * Core E's small reactions to the sessions (2026-10-20): one that starts waiting on you gets a glance;
     * one that finishes (working -> idle) a glance and a grin. The first list only sets the baseline.
     * The sounds (joya-sound.js, every core): the session's role chirps needs / done / think (work starts).
     */
    var lastSt = null;
    function botNotice(list) {
      var was = lastSt;
      lastSt = {};
      list.forEach(function (s) { lastSt[s.id] = s.st; });
      if (!was) return;
      list.forEach(function (s) {
        var p = was[s.id];
        if (!p || p === s.st) return;
        if (s.st === "waiting") { sound("needs", s.role); if (core.react) lookAtSess(s.id, 1600); }
        else if (p === "working" && s.st === "idle") { sound("done", s.role); if (core.react) { lookAtSess(s.id, 1400); core.react("grin"); } }
        else if (s.st === "working" && p !== "waiting") sound("think", s.role);
      });
    }
    /** The core looks at a session for ms (its sphere, followed while it moves). */
    function lookAtSess(id, ms) {
      if (!core.glance || !id) return false;
      core.glance(function () { var p = family && family.enabled() ? family.positions()[id] : pos[id]; return p || null; }, ms);
      return true;
    }
    var busySince = 0;
    function node(id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i]; return null; }
    function flash(id, cls, ms) {
      var n = node(id);
      if (!n) return false;
      n.el.classList.add(cls);
      setTimeout(function () { n.el.classList.remove(cls); }, ms);
      return true;
    }

    return {
      /** The running core (a getter: switching D <-> A/B/C replaces it). */
      get core() { return core; },
      layout: L,
      palette: palette,
      resize: resize,
      start: function () { palette(); if (family) family.enable(spheresOn()); resize(); core.start(); },
      family: family,
      /** The sessions view: "spheres" or "orbit" (no reload). */
      setSessView: function (v) {
        root.setAttribute("data-sessview", v === "orbit" ? "orbit" : "spheres");
        if (family) family.enable(spheresOn());
      },
      setNodes: setNodes,
      /** The core's state: idle, listening, thinking, delegating, speaking or needs. */
      setState: function (name) {
        if (name === state) return;
        // core E: a long turn finished -> a grin (JoyaLogic.botTurnDone)
        var nowMs = Date.now(), ML = window.JoyaLogic;
        var long = !!(ML && ML.botTurnDone && ML.botTurnDone(state, name, busySince ? nowMs - busySince : 0));
        if (long && core.react) core.react("grin");
        // sounds: a long turn done is the "job" chime; JOYA AI starting to think, its chirp
        if (long) sound("job", "core");
        else if (name === "thinking" && (state === "idle" || state === "listening")) sound("think", "core");
        busySince = name === "thinking" || name === "delegating" ? busySince || nowMs : name === "speaking" ? busySince : 0;
        state = name;
        core.setState(name);
        root.setAttribute("data-state", name);
      },
      setConcept: function (c) {
        var cur = core.S.concept === "E" ? "E" : "D";
        if (rendererOf(c) !== cur) swapCore(c);
        else core.setConcept(c);
        root.setAttribute("data-core", core.S.concept);
      },
      /** Core E's head style and colours ({p, c}), in place (no new canvas); kept on #cc for a later switch to E. */
      setBot: function (head, colors) {
        if (head) root.setAttribute("data-bot-head", head);
        if (colors && window.JoyaLogic) root.setAttribute("data-bot-colors", window.JoyaLogic.botColorsJson(colors));
        if (core.S.concept === "E") { if (head && core.setHead) core.setHead(head); if (colors && core.setColors) core.setColors(window.JoyaLogic ? window.JoyaLogic.normBotColors(colors) : colors); }
      },
      /** JOYA AI unreachable: core E shows its error face (the other cores have no offline look). */
      setOffline: function (on) { if (!!on && !offline) sound("error", "core"); offline = !!on; if (core.setOffline) core.setOffline(offline); },
      /** A delegation went out to this session: the stream of dots flies there. */
      send: function (id, ms) {
        var n = node(id);
        clearTimeout(targetTimer);
        nodes.forEach(function (x) { x.el.classList.toggle("target", x.id === id); });
        target = lastTarget = n || (family && family.enabled() && id && family.positions()[id]) ? id : null;
        targetTimer = setTimeout(function () {
          target = null;
          nodes.forEach(function (x) { x.el.classList.remove("target"); });
        }, ms || 2600);
        if (family && family.enabled()) family.send(id);
        return !!n;
      },
      /**
       * A delegation to a target with no sphere (remote, sub-agent, offline, ambiguous): with the
       * spheres on, the stream goes to a marker at the scene's edge named "<name> · <where>", which
       * flashes and fades; never to empty space.
       */
      ghost: function (name, where, ms) {
        if (!family || !family.enabled() || !family.ghost(name, where)) return false;
        var gs = family.ghosts(), g0 = gs[gs.length - 1];
        ghostAt = g0 ? [g0.x, g0.y] : null;
        clearTimeout(targetTimer);
        target = lastTarget = GHOST;
        targetTimer = setTimeout(function () { target = null; }, ms || 2600);
        return true;
      },
      /** A hand-off between two sessions (the day replay): dots from one head to the other; the classic orbit flashes the target. */
      link: function (fromId, toId) { if (family && family.enabled()) return family.link(fromId, toId); return flash(toId, "reply", 1400); },
      /** A session answered: its point flashes (and a thread of dots comes home to her). */
      reply: function (id) { if (family && family.enabled()) family.reply(id); lookAtSess(id, 1400); return flash(id, "reply", 1400); },
      /** Core E: a reaction ("grin", "nod", "surprise"), or "something happened" (poke: a message, a card, typing). */
      react: function (kind) { return core.react ? core.react(kind) : false; },
      poke: function () { if (core.poke) core.poke(); },
      /** Core E: the voice's spectrum for the mouth's shape: fn() -> { bins (getByteFrequencyData), hz per bin } or null. */
      outSpectrum: function (fn) { outSpec = fn; },
      /** Mark the session the composer is addressed to. */
      mark: function (id) { nodes.forEach(function (x) { x.el.classList.toggle("addressed", x.id === id); }); },
      micSource: function (fn) { micLevel = fn; },
      outSource: function (fn) { outLevel = fn; },
      positions: function () { return pos; },
      /** Checks: where the stream is aimed now (the target id, and the point the core's beam flies to). */
      aim: function () { var id = target || lastTarget; return { target: id === GHOST ? "ghost" : id, dest: aimPoint(), ghostAt: ghostAt }; },
      stats: function () { return core.stats(); },
      /** Hand the canvas to fn right after the next frame is drawn (for checks: the pixels are still there). */
      sample: function (fn) { sampler = fn; if (!core.S.running) { core.draw(); } },
    };
  };
})();
