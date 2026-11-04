"use strict";
/*
 * Companion mode (the JOYA AI desktop app; simplified 2026-10-21 -- the user: "I just want the core showing at
 * the centre top of the screen, on top of all apps, always"). The app (desktop/src-tauri/src/companion.rs,
 * companion_host.rs) keeps one small topmost window -- WIN_W x WIN_H logical px -- at the top centre of the
 * monitor you are working on; this file draws the bot in it:
 *
 *   - core E with your head and colours, its states as in the Command Center (ready, listening, thinking,
 *     speaking, needs you; offline), a grin when a long turn is done, its own doze;
 *   - eye contact's look-and-speak indications on its face (joya-presence-bind.js finds it through
 *     JoyaDesktop.companion()), and the "Camera on" pill under it (joya-desktop.js adds the pill's region);
 *   - a quick fade when the app moves it to another monitor (joya://companion fade-out / fade-in) and when it
 *     ducks out of a full-screen video or game (duck / pop);
 *   - its hit region: the bot's circle only -- everything else lets clicks through; a click opens the Command
 *     Center (the app's Peek, on its monitor); hovering shows "Click to open".
 * No blur: the bot has its own backplate (core E's desk mode).
 *
 * The pure parts are exported for the tests (dashboard/tools/test-desktop-companion.cjs): the numbers (equal
 * to companion.rs), layout(), regions(). mount() is the page's: joya-desktop.js calls it with its bridge.
 *
 * No inline style or script (the CSP): positions go through element.style; the bot is one canvas.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JoyaDesktopCompanion = api;
})(typeof self !== "undefined" ? self : this, function () {
  // companion.rs has the same numbers (the test reads both).
  var WIN_W = 176, WIN_H = 160, BODY_R = 52, BODY_CY = 66, FADE_MS = 160;
  var HEAD_R = 70; // the core's radius as core E takes it: the head and its backplate show about 0.8 of it, i.e. about BODY_R

  /** Where the bot sits in the window (CSS px): centred, BODY_CY under the top; the hint under it. */
  function layout(W, H) {
    W = W || WIN_W; H = H || WIN_H;
    var cx = W / 2, cy = Math.min(BODY_CY, H / 2);
    return { W: W, H: H, cx: cx, cy: cy, R: HEAD_R, body: { x: cx, y: cy, r: BODY_R }, hintY: cy + BODY_R + 4 };
  }

  /** The hit regions (CSS px): the bot's circle, clipped to the window; none while faded out. */
  function regions(L, faded) {
    if (faded) return [];
    var b = L.body, x0 = Math.max(0, Math.floor(b.x - b.r)), y0 = Math.max(0, Math.floor(b.y - b.r));
    var x1 = Math.min(L.W, Math.ceil(b.x + b.r)), y1 = Math.min(L.H, Math.ceil(b.y + b.r));
    if (x1 - x0 < 1 || y1 - y0 < 1) return [];
    return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.round(b.r) }];
  }

  /* -------------------------------------------------------------------- the page */
  /**
   * mount({ invoke, listen, report(regions), still() -> hold still now }): builds the companion's canvas and
   * click target and runs it while the app is in Companion mode (not its Peek).
   */
  function mount(o) {
    if (typeof document === "undefined") return null;
    var doc = document, html = doc.documentElement, invoke = o.invoke;
    // The app's events (and, for the checks and the preview, the same handlers by hand: debug.event).
    var handlers = {};
    function listen(name, fn) { handlers[name] = fn; if (o.listen) o.listen(name, fn); }
    var wrap = doc.createElement("div"), cv = doc.createElement("canvas"), hit = doc.createElement("button"), hint = doc.createElement("div");
    wrap.id = "dk-comp"; wrap.hidden = true; wrap.setAttribute("aria-label", "JOYA AI");
    cv.id = "dk-comp-cv"; cv.setAttribute("aria-hidden", "true");
    hit.id = "dk-comp-hit"; hit.type = "button"; hit.className = "dk-comp-hit"; hit.title = "JOYA AI: open the Command Center"; hit.setAttribute("aria-label", "JOYA AI: open the Command Center");
    hint.id = "dk-comp-hint"; hint.className = "dk-comp-hint"; hint.textContent = "Click to open"; hint.setAttribute("aria-hidden", "true");
    wrap.appendChild(cv); wrap.appendChild(hint); wrap.appendChild(hit);
    doc.body.appendChild(wrap);

    var view = {}, core = null, L = layout(WIN_W, WIN_H), on = false, faded = false;
    var lastState = "", busySince = 0;

    function now() { return Date.now(); }
    function isStill() { return !!(o.still && o.still()); }
    function ccRoot() { return doc.getElementById("cc"); }
    function botHead() { var r = ccRoot(); return (r && r.getAttribute("data-bot-head")) || "cap"; }
    function botColors() { var r = ccRoot(), ML = window.JoyaLogic; return r && ML && ML.normBotColors ? ML.normBotColors(r.getAttribute("data-bot-colors") || "") : null; }

    function ensureCore() {
      if (core || !window.JoyaCoreBot) return core;
      try {
        core = window.JoyaCoreBot(cv, { desk: true, backdrop: "glow", head: botHead(), colors: botColors(), kids: function () { return []; } });
      } catch (e) { core = null; }
      return core;
    }
    function place(el, x, y, w, h) { el.style.left = Math.round(x) + "px"; el.style.top = Math.round(y) + "px"; el.style.width = Math.round(w) + "px"; el.style.height = Math.round(h) + "px"; }
    function size() {
      var W = window.innerWidth || WIN_W, H = window.innerHeight || WIN_H;
      L = layout(W, H);
      if (core) { core.resize(L.cx, L.cy, L.R, W, H); if (core.place) core.place(L.cx, L.cy, L.R); }
      place(hit, L.body.x - L.body.r, L.body.y - L.body.r, 2 * L.body.r, 2 * L.body.r);
      hint.style.left = Math.round(L.cx) + "px";
      hint.style.top = Math.round(L.hintY) + "px";
    }

    /** Faded out (moving to another monitor, ducking out) or in: CSS does the fade (none holding still). */
    function fade(out) {
      faded = !!out;
      html.classList.toggle("dk-comp-faded", faded);
      sendRegions(true);
    }

    /* The app's events. */
    listen("joya://companion", function (p) {
      if (!p || !p.kind) return;
      switch (p.kind) {
        case "fade-out": case "duck": fade(true); break;
        case "fade-in": fade(false); break;
        case "pop": fade(false); if (core && core.react) core.react("wake"); break;
      }
    });

    /* A click on the bot: its Command Center (Peek). Hovering: "Click to open". */
    hit.addEventListener("click", function (e) { e.preventDefault(); invoke("companion", { kind: "open" }); });
    hit.addEventListener("mouseenter", function () { html.classList.add("dk-comp-attn"); });
    hit.addEventListener("mouseleave", function () { html.classList.remove("dk-comp-attn"); });

    /* The Command Center's state, mirrored on the bot. */
    function tick() {
      if (!on) return;
      var r = ccRoot(), t = now();
      var state = r ? r.getAttribute("data-state") || "idle" : "idle";
      var off = doc.getElementById("cc-offline");
      if (core) {
        if (core.setOffline) core.setOffline(!!(off && !off.hidden));
        var cs = state === "needs" ? "needs" : core.STATES && core.STATES.indexOf(state) >= 0 ? state : "idle";
        if (cs !== core.S.state) core.setState(cs);
        // a long turn done: a grin (as the Command Center's core)
        var ML = window.JoyaLogic;
        if (lastState && ML && ML.botTurnDone && ML.botTurnDone(lastState, state, busySince ? t - busySince : 0) && core.react) core.react("grin");
        busySince = state === "thinking" || state === "delegating" ? busySince || t : state === "speaking" ? busySince : 0;
        lastState = state;
        if (core.setLight) core.setLight(html.getAttribute("data-theme") === "light");
      }
      sendRegions(false);
    }
    var lastSig = "";
    function sendRegions(force) {
      if (!on || !o.report) return;
      var regs = regions(L, faded);
      var sig = JSON.stringify(regs);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      o.report(regs);
    }
    var timer = null;
    /** On (Companion, its Peek closed) or off (anything else): the bot runs only while it is out. */
    function setOn(yes, v) {
      if (v) view = Object.assign({}, view, v);
      yes = !!yes;
      wrap.hidden = !yes;
      html.classList.toggle("dk-comp-out", yes);
      if (yes && !on) {
        on = true;
        // (the app shows the window again after a duck; the page starts in)
        if (!view.ducked) fade(false);
        ensureCore();
        size();
        if (core) { if (core.setHead) core.setHead(botHead()); if (core.setColors) core.setColors(botColors()); }
        applyStill();
        timer = setInterval(tick, 250);
        tick();
        sendRegions(true);
      } else if (!yes && on) {
        on = false;
        clearInterval(timer);
        if (core) core.stop();
        html.classList.remove("dk-comp-attn");
        html.classList.remove("dk-comp-faded");
        faded = false;
      } else if (yes) size();
    }
    function applyStill() {
      if (!core || !on) return;
      var s = isStill();
      core.S.still = s || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      if (s) { core.stop(); if (core.still) core.still(); } else core.start();
    }
    window.addEventListener("resize", function () { if (on) { size(); sendRegions(true); } });
    return {
      setOn: setOn, applyStill: applyStill, size: size,
      // Eye contact (joya-presence-bind.js): the bot meets your eyes and dozes when you leave, as the core does.
      presence: function (p) { if (core && core.presence) core.presence(p); },
      contact: function (g) { if (core && core.contact) core.contact(g); },
      regions: function () { return regions(L, faded); },
      // For the checks and the preview (a browser has no app to send the events).
      debug: {
        event: function (p, name) { var fn = handlers[name || "joya://companion"]; if (fn) fn(p); },
        core: function () { return core; },
        layout: function () { return L; },
        faded: function () { return faded; },
        tick: tick,
      },
    };
  }

  return {
    WIN_W: WIN_W, WIN_H: WIN_H, BODY_R: BODY_R, BODY_CY: BODY_CY, HEAD_R: HEAD_R, FADE_MS: FADE_MS,
    layout: layout, regions: regions, mount: mount,
  };
});
