"use strict";
/*
 * The Command Center as a shell (M-5 part 2). Another Joya page opens in a
 * same-origin frame over the Command Center instead of replacing it, so what
 * lives here goes on while you look at the other page: the live call, the
 * event stream, the voice. JOYA AI's core flies down into the dock and back up
 * when you return (from the approved mockup, scratchpad joya-dock).
 *
 *   JoyaShell.open(url)   show that page (a path of this site) -- page.open, or
 *                         a link clicked in the Command Center
 *   JoyaShell.expand()    back to the Command Center
 *   JoyaShell.back()      the browser's back (Undo of a page.open)
 *   JoyaShell.active()    a page is up (or on its way up)
 *   JoyaShell.feed(f)     joya-ai.js: what the Command Center is doing, for the dock
 *   JoyaShell.toast(...)  a note on the dock while a page is up
 *
 * History: each switch is an entry (/joya-ai?at=<path> for a page, /joya-ai
 * for the Command Center), so back and forward move between them; moves inside
 * the frame are the browser's own entries, and the address follows them. A
 * link to /joya-ai?at=<path> opens straight onto that page (a deep link).
 *
 * The page in the frame talks back through app.js (only when framed): where it
 * is and its title, theme changes; a signed-out page,
 * logout and the Command Center itself leave the frame. Messages are accepted
 * only from this origin and from the frame's own window.
 *
 * Nothing here changes how the Command Center looks while it is the one shown:
 * every class and inline style set for a flight is removed when it lands.
 *
 * With core D (the mesh) the core in flight is the mesh itself: a core D on a
 * canvas of its own (made for the flight, its GPU context released when it
 * lands) that adopts the running core's state and every phase at take-off and
 * hands them on at landing -- to the dock's mesh going down, to the Command
 * Center's core coming back up -- so neither end shows a swap. It is driven
 * by this file's frame (place / tick), and carries the session spheres (fading
 * with the Command Center) so they do not blink out. The Command Center's core
 * stops for the flight (one WebGL context draws at a time, besides the dock's
 * small one). Core E (the bot) flies the same way, as a bot head (joya-core-bot.js) with the
 * viewer's head style and colours, the sessions riding along as small bots. A, B and C keep
 * the dotted 2D flight below.
 */
(function () {
  var root = document.getElementById("joya-dock-root");
  var frame = document.getElementById("md-frame");
  var hero = document.getElementById("md-hero");
  if (!root || !frame || !hero || root.getAttribute("data-shell") !== "1") return;
  var html = document.documentElement;
  var cc = document.getElementById("cc");
  var dockEl = document.getElementById("md-dock");
  var ORIGIN = location.origin;
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var D = function () { return window.__joyaDock || null; };
  var CCx = function () { return window.__joyaCC || null; };
  var baseTitle = document.title;
  var mode = "full"; // full | down | dock | up
  var fl = null, raf = 0, last = 0;

  /* ------------------------------------------------------------ where */
  function isCC(path) { return path === "/joya-ai" || path === "/joya-ai/"; }
  /** A path of this site that may be shown in the frame, normalised; null otherwise. */
  function safePath(u) {
    var x;
    try { x = new URL(String(u || ""), ORIGIN); } catch (e) { return null; }
    if (x.origin !== ORIGIN || !/^\/(?!\/)/.test(x.pathname)) return null;
    if (isCC(x.pathname) || /^\/(logout|login|joya-ai\/api)(\/|$)/.test(x.pathname)) return null;
    return x.pathname + x.search + x.hash;
  }
  function frameUrl() {
    try {
      var l = frame.contentWindow.location;
      return l.href === "about:blank" ? null : l.pathname + l.search + l.hash;
    } catch (e) { return null; }
  }
  function ccUrl(p) { return "/joya-ai?at=" + encodeURIComponent(p); }

  /* ------------------------------------------------------------ the Command Center under the frame */
  // Out of reach of the keyboard and screen readers while a page is up (no visual change).
  function setInert(on) {
    (function walk(parent) {
      [].forEach.call(parent.children, function (el) {
        if (el === root || el.tagName === "SCRIPT") return;
        if (el.contains(root)) return walk(el);
        if (on) { if (!el.hasAttribute("inert")) { el.setAttribute("inert", ""); el.setAttribute("data-md-inert", ""); } }
        else if (el.hasAttribute("data-md-inert")) { el.removeAttribute("inert"); el.removeAttribute("data-md-inert"); }
      });
    })(document.body);
  }
  function coreStop() { var c = CCx(); if (c && c.core && c.core.stop) c.core.stop(); }
  function coreStart() { var c = CCx(); if (!c) return; if (c.orbit && c.orbit.resize) c.orbit.resize(); if (c.core && c.core.start) c.core.start(); }
  function coreLayout() {
    var c = CCx(), L = c && c.orbit && c.orbit.layout;
    if (L && L.R) return { cx: L.cx, cy: L.cy, R: L.R };
    return { cx: innerWidth / 2, cy: innerHeight / 2, R: Math.min(innerWidth, innerHeight) * 0.3 };
  }

  /* ------------------------------------------------------------ the dotted core in flight (2D, concept C) */
  var PI = Math.PI, t = 0, DPR = 1, VW = 0, VH = 0, g = hero.getContext("2d");
  function points(n, seed) {
    var dir = new Float32Array(n * 3), rnd = new Float32Array(n), ga = PI * (3 - Math.sqrt(5)), sd = seed;
    function r_() { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = ga * i;
      dir[i * 3] = Math.cos(th) * rad; dir[i * 3 + 1] = y; dir[i * 3 + 2] = Math.sin(th) * rad; rnd[i] = r_();
    }
    return { dir: dir, rnd: rnd, n: n };
  }
  var PBIG = points(2600, 7), PMID = points(900, 7), PSMALL = points(420, 7);
  function isLight() {
    var th = html.getAttribute("data-theme");
    if (th) return th === "light";
    return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function mix(a, b, k) { return a + (b - a) * k; }
  function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function rgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a.toFixed(3) + ")"; }
  function ease(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function drawCore(P, cx, cy, R, size, alpha) {
    var light = isLight(), M = light ? [0, 143, 102] : [0, 230, 165], V = light ? [115, 33, 196] : [153, 77, 255];
    var rot = t * 0.18, cr = Math.cos(rot), sr = Math.sin(rot), base = light ? 0.16 : 0.07;
    for (var i = 0; i < P.n; i++) {
      var dx = P.dir[i * 3], dy = P.dir[i * 3 + 1], dz = P.dir[i * 3 + 2], r1 = P.rnd[i];
      var r = 1 + 0.022 * Math.sin(t * 1.05) + 0.03 * Math.sin(Math.acos(dy) * 5 + t * 0.7);
      var X = (cr * dx + sr * dz) * r, Y = dy * r, Z = (-sr * dx + cr * dz) * r;
      var Y2 = Y * 0.955 - Z * 0.296, Z2 = Y * 0.296 + Z * 0.955, persp = 3.3 / (3.3 - Z2);
      var depth = clamp((Z2 + 1.25) / 2.5, 0, 1), gc = clamp(0.5 + 0.62 * (X * 0.6 + Y2 * 0.6), 0, 1);
      g.globalAlpha = Math.min(1, (base + (1 - base) * Math.pow(depth, 1.4)) * alpha);
      g.fillStyle = rgb(mix3(M, V, gc));
      var sz = size * (0.6 + 1.2 * depth * depth) * persp * (r1 > 0.975 ? 1.7 : 1);
      g.fillRect(cx + X * R * persp - sz / 2, cy - Y2 * R * persp - sz / 2, sz, sz);
    }
    g.globalAlpha = 1;
    var hg = g.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.5);
    hg.addColorStop(0, rgba(M, (light ? 0.08 : 0.13) * alpha)); hg.addColorStop(1, rgba(V, 0));
    g.fillStyle = hg; g.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);
  }
  function heroSize() {
    DPR = Math.min(2, window.devicePixelRatio || 1); VW = innerWidth; VH = innerHeight;
    hero.width = Math.round(VW * DPR); hero.height = Math.round(VH * DPR);
  }
  function pose() {
    var p = ease(fl.p), a = fl.from, b = fl.to;
    return {
      cx: mix(a.cx, b.cx, p),
      cy: mix(a.cy, b.cy, p) - Math.sin(p * PI) * (fl.dir === "down" ? 40 : -30),
      R: Math.exp(mix(Math.log(a.R), Math.log(b.R), p)),
    };
  }

  /* ------------------------------------------------------------ the mesh in flight (core D) */
  var heroD = null, heroCv = null, kidsA = 1;
  function famNow() { var c = CCx(); return c && c.orbit && c.orbit.family; }
  function coreIsD() { var c = CCx(); return !!(window.JoyaCoreD && c && c.core && c.core.S && c.core.S.concept === "D" && c.core.isGL); }
  /** Core E (the bot) flies itself too: a bot on the flight's canvas (WebGL2, else its 2D renderer). */
  function coreIsE() { var c = CCx(); return !!(window.JoyaCoreBot && c && c.core && c.core.S && c.core.S.concept === "E"); }
  /** A core D for this flight, carrying on from `src` (the Command Center's core, or the dock's). */
  function meshUp(src) {
    heroCv = document.createElement("canvas");
    heroCv.className = "md-hero md-hero-d on";
    heroCv.setAttribute("aria-hidden", "true");
    hero.parentNode.insertBefore(heroCv, hero.nextSibling);
    var E = src && src.S && src.S.concept === "E", LG = window.JoyaLogic;
    heroD = (E ? window.JoyaCoreBot : window.JoyaCoreD)(heroCv, {
      noGuard: true,
      head: E ? src.S.head : null, colors: E && cc && LG ? LG.normBotColors(cc.getAttribute("data-bot-colors") || "") : null,
      backdrop: "glow",
      // the session spheres ride along, fading with the Command Center
      kids: function () { var f = famNow(), k = f && f.enabled() && f.meshKids ? f.meshKids() : null; if (!k) return null; return k.map(function (x) { x.alpha *= kidsA; return x; }); },
      beforeDraw: function () { var f = famNow(); if (f && f.enabled()) f.frame(); },
    });
    if (!heroD.isGL && !E) { meshDown(); return false; }
    heroD.resize(innerWidth / 2, innerHeight / 2, 100, innerWidth, innerHeight);
    heroD.adopt(src);
    heroD.setLight(isLight(), true);
    return true;
  }
  /** Hand the state on (to the core that takes over) and free the flight's canvas and context. */
  function meshDown(dst) {
    if (heroD && dst && dst.adopt) dst.adopt(heroD);
    if (heroD) heroD.destroy();
    if (heroCv && heroCv.parentNode) heroCv.parentNode.removeChild(heroCv);
    heroD = heroCv = null;
  }

  /* ------------------------------------------------------------ the flights */
  function setOp(el, o) { if (el) el.style.opacity = o === "" ? "" : String(o); }
  function step(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    t += dt;
    if (!fl) { raf = 0; return; }
    fl.p = Math.min(1, fl.p + dt / fl.dur);
    var p = fl.p;
    if (fl.dir === "down") {
      setOp(cc, 1 - clamp(p / 0.38, 0, 1));
      setOp(frame, clamp((p - 0.4) / 0.42, 0, 1));
      setOp(dockEl, clamp((p - 0.7) / 0.3, 0, 1));
    } else {
      setOp(frame, 1 - clamp(p / 0.33, 0, 1));
      setOp(dockEl, 1 - clamp(p / 0.25, 0, 1));
      if (p > 0.35 && !frame.hidden) frame.hidden = true;
      setOp(cc, clamp((p - 0.55) / 0.4, 0, 1));
      if (p > 0.9 && !heroD && html.classList.contains("md-flying")) html.classList.remove("md-flying"); // the real core takes over (the mesh hands over at landing)
    }
    var q = pose();
    if (heroD) {
      // the mesh itself flies: the same look all the way, scaled along the path; no fade at either end
      kidsA = fl.dir === "down" ? 1 - clamp(p / 0.38, 0, 1) : clamp((p - 0.55) / 0.4, 0, 1);
      heroD.place(q.cx, q.cy, q.R);
      heroD.tick(dt);
    } else {
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, VW, VH);
      var fade = fl.dir === "up" ? 1 - clamp((p - 0.9) / 0.1, 0, 1) : 1;
      drawCore(q.R > 90 ? PBIG : q.R > 40 ? PMID : PSMALL, q.cx, q.cy, q.R, q.R > 90 ? 1.5 : 1.15, fade);
    }
    if (p >= 1) return land();
    raf = requestAnimationFrame(step);
  }
  function fly(dir) {
    heroSize();
    fl = { dir: dir, p: 0, dur: dir === "down" ? 1.05 : 1.0 };
    var dm = D().mesh ? D().mesh() : null, mesh = false;
    if (coreIsD() || coreIsE()) {
      var c = CCx();
      mesh = meshUp(dir === "down" ? c.core : dm || c.core);
      if (mesh) coreStop(); // the flight's mesh draws; the Command Center's core waits for its hand-over
    }
    if (dir === "down") { fl.from = coreLayout(); fl.to = D().orbRect(); }
    else { fl.from = D().orbRect(); if (!mesh) coreStart(); else { var c2 = CCx(); if (c2 && c2.orbit && c2.orbit.resize) c2.orbit.resize(); } fl.to = coreLayout(); }
    // the dock's mesh is drawn at R 21 in its 68 px canvas: land on (and leave from) exactly that size
    if (mesh && dm) { var dR = dm.S && dm.S.concept === "E" ? 27 : 21; if (dir === "down") fl.to.R = dR; else fl.from.R = dR; }
    html.classList.add("md-flying");
    html.classList.toggle("md-fly-mesh", mesh); // the dock's own small mesh hides while the flying one is on its way
    if (!mesh) hero.classList.add("on");
    last = 0;
    if (!raf) raf = requestAnimationFrame(step);
  }
  function land() {
    var dir = fl ? fl.dir : mode === "down" ? "down" : "up";
    var wasMesh = !!heroD;
    fl = null;
    raf = 0;
    if (wasMesh) {
      // hand the mesh on: down to the dock's mesh, up to the Command Center's core (then start it)
      if (dir === "down") meshDown(D().mesh ? D().mesh() : null);
      else { var c = CCx(); meshDown(c && c.core); }
    }
    hero.classList.remove("on");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, hero.width, hero.height);
    html.classList.remove("md-flying");
    html.classList.remove("md-fly-mesh");
    setOp(cc, ""); setOp(frame, ""); setOp(dockEl, "");
    if (dir === "down") {
      mode = "dock";
      frame.hidden = false;
      setInert(true);
      coreStop();
      document.title = frameTitle() || baseTitle;
      if (!root.contains(document.activeElement)) { try { frame.focus(); } catch (e) { /* fine */ } }
    } else {
      mode = "full";
      if (wasMesh) coreStart(); // the Command Center's core, carrying on from the mesh that flew
      frame.hidden = true;
      D().show(false);
      document.title = baseTitle;
      document.dispatchEvent(new CustomEvent("joya-shell-full")); // back on the Command Center: its caption starts from the idle line
    }
    paintFeed();
  }
  /** Finish a flight at once (a new switch arrives while one is under way). */
  function finish() { if (fl) { fl.p = 1; step(performance.now()); } }

  /* ------------------------------------------------------------ open / expand */
  function loadFrame(p) {
    var cur = frameUrl();
    if (cur === p) return;
    if (!frame.getAttribute("src") || !cur) frame.setAttribute("src", p); // the first load replaces about:blank
    else frame.contentWindow.location.replace(p); // no extra history entry: the shell writes its own
  }
  function open(url, o) {
    o = o || {};
    var p = safePath(url);
    if (!p) return false;
    finish();
    if (mode === "dock") {
      // A page is up already: move the frame, as a normal step in its history.
      if (frameUrl() !== p) { try { frame.contentWindow.location.assign(p); } catch (e) { loadFrame(p); } }
      return true;
    }
    loadFrame(p);
    if (o.push !== false) history.pushState({ joya: "frame", url: p }, "", ccUrl(p));
    mode = "down";
    D().show(true);
    if (reduced || o.instant) { frame.hidden = false; land(); return true; }
    setOp(frame, 0);
    setOp(dockEl, 0);
    frame.hidden = false;
    fly("down");
    return true;
  }
  function expand(o) {
    o = o || {};
    finish();
    if (mode !== "dock") return false;
    if (o.push !== false) history.pushState({ joya: "cc" }, "", "/joya-ai");
    mode = "up";
    setInert(false);
    if (reduced || o.instant) { coreStart(); land(); return true; }
    setOp(cc, 0);
    fly("up");
    return true;
  }

  /* ------------------------------------------------------------ history */
  window.addEventListener("popstate", function (e) {
    var s = e.state;
    if (s && s.joya === "frame" && safePath(s.url)) {
      if (mode === "dock" || mode === "down") { if (frameUrl() !== s.url) loadFrame(s.url); return; }
      open(s.url, { push: false });
    } else if (mode === "dock" || mode === "down") expand({ push: false });
  });

  /* ------------------------------------------------------------ the frame's page */
  function frameTitle() { try { return frame.contentDocument.title || ""; } catch (e) { return ""; } }
  function followFrame() {
    var p = frameUrl();
    if (!p) return;
    try {
      if (isCC(frame.contentWindow.location.pathname)) { // the Command Center inside itself: come back instead
        frame.contentWindow.location.replace("about:blank");
        frame.removeAttribute("src");
        return void expand();
      }
    } catch (e) { return; }
    if (mode === "dock" || mode === "down") {
      history.replaceState({ joya: "frame", url: p }, "", ccUrl(p));
      if (mode === "dock") document.title = frameTitle() || baseTitle;
    }
    sendTheme();
  }
  frame.addEventListener("load", followFrame);
  function applyTheme(pref) {
    if (["system", "dark", "light"].indexOf(pref) < 0) return;
    var now = html.getAttribute("data-theme") || "system";
    if (now === pref) return;
    var b = document.querySelector('[data-theme-switch] button[data-theme-opt="' + pref + '"]');
    if (b) b.click();
    else {
      if (pref === "system") html.removeAttribute("data-theme"); else html.setAttribute("data-theme", pref);
      try { window.localStorage.setItem("joya-theme", pref); } catch (e) { /* storage blocked */ }
      document.dispatchEvent(new CustomEvent("joya-theme", { detail: { theme: pref } }));
    }
  }
  function sendTheme() {
    try { frame.contentWindow.postMessage({ joya: "theme", theme: html.getAttribute("data-theme") || "system" }, ORIGIN); } catch (e) { /* not loaded */ }
  }
  document.addEventListener("joya-theme", sendTheme);
  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
    var m = e.data && typeof e.data === "object" ? e.data : {};
    if (m.joya === "nav") followFrame();
    else if (m.joya === "expand") expand();
    else if (m.joya === "theme") applyTheme(m.theme);
  });

  /* ------------------------------------------------------------ links in the Command Center open in the frame */
  document.addEventListener("click", function (e) {
    if (mode !== "full" || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || root.contains(a) || a.target === "_blank" || a.hasAttribute("download")) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var p = safePath(a.href);
    if (!p) return;
    e.preventDefault();
    open(p);
  });

  /* ------------------------------------------------------------ the dock's feed and notes */
  function liveOn() { var L = window.__joyaLive; return !!(L && L.active && L.active()); }
  var lastFeed = null;
  function paintFeed() { if (lastFeed && D() && D().feed) D().feed(lastFeed); }
  function toast(text, undo, link, bad) {
    var d = D();
    if (!d) return;
    // "Open" shows the page in the frame; it never moves the whole tab while a live call is on (that would end it).
    var action = undo ? { label: "Undo", fn: undo } : link ? { label: "Open", fn: function () { if (open(link)) return; if (liveOn()) return d.toast("That page cannot open here during a live call — end the call first.", { bad: true }); location.assign(link); } } : null;
    d.toast(text, { action: action, bad: !!bad });
  }

  window.JoyaShell = {
    open: open,
    expand: function () { return expand(); },
    back: function () { history.back(); },
    active: function () { return mode === "dock" || mode === "down"; },
    framed: function () { return mode === "dock"; },
    mode: function () { return mode; },
    /** The page in the frame: { path, title } (for the live call's "what is on my screen"), or null. */
    where: function () { var p = frameUrl(); return p && (mode === "dock" || mode === "down") ? { path: p, title: frameTitle() } : null; },
    feed: function (f) { lastFeed = f; if (D() && D().feed) D().feed(f); },
    toast: toast,
    /** A Tier-2 confirm while a page is up: Confirm / Cancel on the dock (returns {remove, expired}). */
    confirm: function (text, onYes, onNo) { return D().confirm(text, onYes, onNo); },
    finish: finish,
  };

  /* ------------------------------------------------------------ boot: a deep link, and this entry's state */
  var at = null;
  try { at = new URLSearchParams(location.search).get("at"); } catch (e) { at = null; }
  var deep = at ? safePath(at) : null;
  if (deep) {
    history.replaceState({ joya: "cc" }, "", "/joya-ai" + (location.hash || "")); // back from the page lands here
    open(deep, { instant: true });
  } else history.replaceState({ joya: "cc" }, "", location.pathname + location.search + location.hash);
})();
