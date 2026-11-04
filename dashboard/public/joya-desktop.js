"use strict";
/*
 * The Command Center's desktop render mode (/joya-ai?shell=desktop): the page
 * the JOYA AI desktop app for Windows shows in its transparent window
 * (desktop/ in this repo; design: mockups/desktop-app/DESIGN.md).
 *
 * It is the same Command Center (joya-ai.js, the core, the spheres, the
 * composer, the decision card, the live call) with no page around it. This
 * file only:
 *   - lays the pieces out for the app's mode (Floating, Peek, Desktop layer;
 *     public/joya-desktop-layout.js holds the numbers), size, position and
 *     focus mode. Nothing of the conversation shows by itself (0.1.2): a small
 *     chat button on the core opens the chat panel -- the recent conversation
 *     with the composer (moved in from the page) -- and a reply that comes
 *     while it is closed only lights a dot on the button;
 *   - tells the app which parts of the window catch the mouse, so the rest
 *     lets clicks through to the desktop (set_hit_regions, ~10 a second while
 *     anything moves, only when the list changed);
 *   - passes the app's hotkeys in (hold-to-talk, focus, Esc) and the core's
 *     state out (the tray dot, a Windows toast when something needs you and
 *     the layer cannot be seen -- the app decides; a toast only opens or
 *     denies, never approves);
 *   - on the sign-in pages, makes the card float on the desktop and offers
 *     "sign in in your browser" (the app's one-time-code hand-off);
 *   - Companion mode (simplified 2026-10-21): the bot alone, in a small topmost window the app keeps at the top
 *     centre of the monitor you are working on -- public/joya-desktop-companion.js draws it; a click on it opens the app's
 *     Peek (st.peekOpen), laid out as Peek.
 *
 * The bridge to the app is Tauri's (window.__TAURI__, injected by the app
 * only into joya.example.com): a fixed list of commands, none of which can
 * run a program or read a file (desktop/src-tauri/capabilities/remote.json).
 * In a plain browser there is no bridge: the page reads its mode from the
 * address (?mode=floating&focus=1&size=M&ink=light) so it can be looked at
 * and tested, and does nothing else.
 *
 * No inline style or script (the CSP): positions go through element.style.
 */
(function () {
  var html = document.documentElement;
  if (!html.classList.contains("cc-desk")) return;
  var LAY = window.JoyaDesktopLayout;
  var T = window.__TAURI__ || null;
  function invoke(cmd, args) {
    if (!T || !T.core || !T.core.invoke) return Promise.resolve(null);
    if (cmd === "needs_you" && window.JoyaPresenceHold && window.JoyaPresenceHold.native(args)) return Promise.resolve(false); // eye contact: you are away
    try { return T.core.invoke(cmd, args || {}).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
  }
  function listen(name, fn) {
    if (!T || !T.event || !T.event.listen) return;
    try { T.event.listen(name, function (e) { try { fn(e.payload || {}); } catch (x) { /* one bad event never stops the page */ } }); } catch (e) { /* no events */ }
  }
  function $(id) { return document.getElementById(id); }
  function px(n) { return Math.round(n) + "px"; }

  var Q;
  try { Q = new URLSearchParams(location.search); } catch (e) { Q = { get: function () { return null; } }; }
  var st = {
    mode: Q.get("mode") || "floating", focus: Q.get("focus") === "1", size: Q.get("size") || "M", pos: Q.get("pos") || "",
    ink: Q.get("ink") === "dark" ? "dark" : "light", opacity: 100, still: Q.get("still") === "1", peekOpen: Q.get("open") !== "0",
    talkKey: Q.get("talk") || "Ctrl+Space", liveKey: T ? "" : Q.get("livekey") || "Ctrl+Alt+L", hidden: false, host: !!T,
    glass: !T && Q.get("glass") === "1",
    // The glance cards (0.1.9): in the app as its state says (on unless switched off); in a browser only with ?glance=1.
    glance: !T && Q.get("glance") === "1", glancePin: T ? null : browserPin(),
  };
  // What the app's state carries (joya://state, get_state).
  var STATE_KEYS = ["mode", "focus", "size", "pos", "ink", "opacity", "still", "peekOpen", "talkKey", "liveKey", "hidden", "glass", "glance", "glancePin", "companion"];
  /* Companion mode: the bot out on the desk (its own small window), or -- a click on it -- its Command Center, laid out as Peek. */
  function compOut() { return st.mode === "companion" && !st.peekOpen; }
  function lmode() { return st.mode === "companion" ? (st.peekOpen ? "peek" : "companion") : st.mode; }
  function peekish() { return st.mode === "peek" || st.mode === "companion"; }
  var CMP = window.JoyaDesktopCompanion, comp = null;
  /** In a browser (no app to remember it): ?pin=x,y (fractions of the window), else this browser's last pin. */
  function browserPin() {
    var q = String(Q.get("pin") || "").split(",").map(Number);
    if (q.length === 2 && isFinite(q[0]) && isFinite(q[1])) return { x: q[0], y: q[1] };
    try { var v = JSON.parse(window.localStorage.getItem("joya-desk-glance-pin") || "null"); return v && isFinite(v.x) && isFinite(v.y) ? v : null; } catch (e) { return null; }
  }
  html.classList.toggle("dk-host", !!T);

  /* ---------------------------------------------------------------- applying the app's state */
  function apply() {
    html.setAttribute("data-dk-mode", lmode());
    html.classList.toggle("dk-companion", st.mode === "companion");
    html.classList.toggle("dk-focus", !!st.focus);
    html.classList.toggle("dk-peek-open", peekish() && !!st.peekOpen);
    // Companion and signed out: the sign-in card needs the room -- open its Peek.
    if (compOut() && !$("cc") && T) invoke("companion", { kind: "open" });
    html.classList.toggle("dk-still", !!st.still);
    html.classList.toggle("dk-acrylic", !!st.glass);
    // Ink follows the wallpaper: light ink (the dark theme) on a dark or busy wallpaper, dark ink on a light one.
    html.setAttribute("data-theme", st.ink === "dark" ? "light" : "dark");
    try { document.dispatchEvent(new CustomEvent("joya-theme")); } catch (e) { /* old engine */ }
    var cc = $("cc") || document.body;
    cc.style.opacity = String(Math.max(0.35, Math.min(1, (Number(st.opacity) || 100) / 100)));
    var kb = $("dk-kb");
    if (kb) {
      var keys = String(st.talkKey).split("+");
      kb.innerHTML = '<span class="dk-kb-w">hold </span>' + keys.map(function (k) { return "<b>" + esc(k) + "</b>"; }).join("") + '<span class="dk-kb-w"> to talk</span>';
      kb.title = "Hold " + keys.join("+") + " to talk";
    }
    // Focus mode: the core alone -- the session spheres (drawn by the core) go too.
    var cc2 = window.__joyaCC, fam = cc2 && cc2.orbit && cc2.orbit.family, root = $("cc");
    if (fam && fam.enable && root) fam.enable(!st.focus && root.getAttribute("data-sessview") !== "orbit");
    layout();
    still();
    fitHint();
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var L = null;
  function layout() {
    if (comp) comp.setOn(compOut() && !!$("cc"), st.companion || null);
    if (compOut() && $("cc")) {
      // The bot out on the desk: the Command Center's own pieces stay hidden (joya-desktop.css); the core's spot is the bot's.
      var cl = CMP.layout(window.innerWidth, window.innerHeight);
      L = { mode: "companion", W: cl.W, H: cl.H, cx: cl.cx, cy: cl.cy, R: cl.R, box: { x: 0, y: 0, w: cl.W, h: cl.H }, glance: null, panel: null, card: null, tools: null };
      if (chatOpen()) closeChat();
      return report(true);
    }
    L = LAY.layout({ mode: lmode(), size: st.size, pos: st.pos, focus: st.focus, W: window.innerWidth, H: window.innerHeight, glance: !!st.glance && !!$("cc"), pin: st.mode === "desktop" ? st.glancePin : null });
    if (!$("cc")) { layoutAuth(); return report(true); }
    var cap = $("cc-caption"), need = $("cc-need"), tools = $("dk-tools"), core = $("dk-corehit"), btn = $("dk-chatbtn"), panel = $("dk-panel");
    if (btn) place(btn, L.chatBtn.x - L.chatBtn.d / 2, L.chatBtn.y - L.chatBtn.d / 2, L.chatBtn.d, L.chatBtn.d);
    var lb = $("dk-livebtn");
    if (lb) place(lb, L.liveBtn.x - L.liveBtn.d / 2, L.liveBtn.y - L.liveBtn.d / 2, L.liveBtn.d, L.liveBtn.d);
    // Where an opened sheet, dialog or conversation goes: Floating, inside the box; otherwise a large centred panel.
    var ov = L.mode === "floating" ? { x: 8, y: L.box.y + 8, w: L.box.w - 16, h: L.box.h - 16 } : { w: Math.min(1040, L.W - 48), h: L.H - 48, y: 24 };
    if (ov.x == null) ov.x = (L.W - ov.w) / 2;
    ["x", "y", "w", "h"].forEach(function (k) { html.style.setProperty("--dk-ov-" + k, px(ov[k])); });
    if (panel) place(panel, L.panel.x, L.panel.y, L.panel.w, L.panel.h);
    if (st.focus && chatOpen()) closeChat();
    if (cap) { cap.style.left = px(L.caption.x); cap.style.top = px(L.caption.y); }
    if (need) {
      need.style.left = px(L.card.x); need.style.width = px(L.card.w);
      if (L.card.bottom != null) { need.style.top = "auto"; need.style.bottom = px(L.card.bottom); need.style.maxHeight = px(L.card.h); }
      else { need.style.bottom = "auto"; need.style.top = px(L.card.y); need.style.maxHeight = px(L.card.h); }
    }
    if (tools) { tools.hidden = !L.tools; if (L.tools) place(tools, L.tools.x, L.tools.y); }
    if (core) place(core, L.cx - L.R, L.cy - L.R, 2 * L.R, 2 * L.R);
    placeGlance();
    // "Not reachable": under the core, where the sign-in card goes, not over it.
    var off = $("cc-offline");
    if (off) { off.style.left = px(L.gate.x); off.style.top = px(L.gate.y); off.style.transform = "translateX(-50%)"; }
    // Floating: the core's glow is clipped to the box with round corners (the mockup's clip), never the window's square.
    var clip = L.mode === "floating" ? "inset(" + px(L.box.y) + " " + px(L.W - L.box.x - L.box.w) + " " + px(L.H - L.box.y - L.box.h) + " " + px(L.box.x) + " round 28px)" : "none";
    ["cc-core", "cc-family"].forEach(function (id) { var c = $(id); if (c) c.style.clipPath = clip; });
    var cc = window.__joyaCC;
    if (cc && cc.orbit && cc.orbit.resize) cc.orbit.resize();
    renderChat();
    report(true);
  }
  /**
   * The composer's "hold Ctrl Space to talk" hint never squeezes the message box: when the box is
   * too narrow for its placeholder (a small or scaled screen, a long talk key), the hint shortens to
   * the key caps alone, and if even that does not fit it goes. Measured, not guessed: the fonts differ
   * between machines. Runs when the composer or the box changes width and on apply.
   */
  var measureCv = null;
  function textW(el, text) {
    try {
      measureCv = measureCv || document.createElement("canvas");
      var g = measureCv.getContext("2d"), cs = getComputedStyle(el);
      g.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      return g.measureText(text || "").width;
    } catch (e) { return 0; }
  }
  function fitHint() {
    var kb = $("dk-kb"), inp = $("cc-input");
    if (!kb || !inp) return;
    var form = inp.closest("form");
    if (!form || !form.getBoundingClientRect().width) return; // the panel is closed: measured when it opens
    var need = Math.ceil(textW(inp, inp.placeholder) + 8);
    kb.classList.remove("dk-kb-short", "dk-kb-none");
    if (inp.clientWidth >= need) return;
    kb.classList.add("dk-kb-short");
    if (inp.clientWidth >= need) return;
    kb.classList.add("dk-kb-none");
  }
  if (window.ResizeObserver) {
    // The form (the panel opening, a resize) and the box itself (the mic or the stop button coming and going).
    try {
      var ro = new ResizeObserver(function () { fitHint(); });
      ["cc-compose", "cc-input"].forEach(function (id) { if ($(id)) ro.observe($(id)); });
    } catch (e) { /* no observer: apply() still fits it */ }
  }
  function place(el, x, y, w, h) {
    if (!el) return;
    el.style.left = px(x); el.style.top = px(y);
    if (w != null) el.style.width = px(w);
    if (h != null) el.style.height = px(h);
  }
  /**
   * The sign-in pages: the core grey and still (signed out), the card under it, where the
   * mode's gate goes; a tall card pushes the core up rather than off the window.
   */
  var authCore = null;
  function layoutAuth() {
    var card = document.querySelector(".auth-wrap .card");
    if (!card) return;
    var w = Math.min(360, L.W - 24);
    card.style.width = px(w);
    var ch = card.offsetHeight, R = st.focus ? L.R : Math.min(L.R, 120);
    var y = L.mode === "floating" ? Math.max(8, L.H - ch - 16) : Math.max(16, Math.min(L.gate.y, L.H - ch - 16));
    var x = L.mode === "floating" ? (L.W - w) / 2 : L.cx - w / 2;
    place(card, Math.max(12, Math.min(L.W - w - 12, x)), y);
    var cy = Math.min(L.cy, y - R - 24), cx = L.mode === "floating" ? L.W / 2 : L.cx;
    if (cy - R < 0 || !window.JoyaCoreD) { if (authCore) authCore.cv.hidden = true; return; }
    if (!authCore) {
      var cv = document.createElement("canvas");
      cv.className = "dk-auth-core";
      cv.setAttribute("aria-hidden", "true");
      document.body.appendChild(cv);
      try { authCore = { cv: cv, core: window.JoyaCoreD(cv, { backdrop: "glow" }) }; } catch (e) { authCore = { cv: cv, core: null }; }
    }
    authCore.cv.hidden = false;
    var k = authCore.core;
    if (!k) return;
    k.resize(cx, cy, R, L.W, L.H);
    if (k.setLight) k.setLight(st.ink === "dark");
    if (k.S && k.S.running) k.stop();
    if (k.still) k.still(); else if (k.draw) k.draw();
  }

  /** Where the core is, for cc-map.js (it asks through joya-ai.js). */
  window.JoyaDesktop = {
    coreLayout: function () { return L ? { cx: L.cx, cy: L.cy, R: L.R } : null; },
    state: function () { return st; },
    layout: function () { return L; },
    regions: function () { return lastRegions; },
    glance: function () { var g = $("dk-glance"); return { on: !!(g && !g.hidden), layout: L && L.glance, caps: glCaps }; },
    glass: function () { return glassSent.slice(); },
    hint: function () { var kb = $("dk-kb"); return !kb ? "none" : kb.classList.contains("dk-kb-none") ? "hidden" : kb.classList.contains("dk-kb-short") ? "keys" : "full"; },
  };

  /* ---------------------------------------------------------------- the chat panel
     Closed by default. The chat button on the core opens it: the recent
     conversation (scrollable, the last LOG_KEEP exchanges, from the Command
     Center's own turns) and the composer, moved in here from the page so it
     is the same composer (joya-ai.js keeps driving it). It closes on the
     button again, its X, Esc or a click outside it. A reply that arrives
     while it is closed lights a dot on the button; nothing else shows. The
     words of a live call appear as a ghost line while they are said. */
  var LOG_KEEP = 20;
  var ghost = null;
  var dockHome = $("dk-panel-dock"), dockEl = $("cc-dock");
  if (dockHome && dockEl) dockHome.appendChild(dockEl);
  function chatOpen() { var p = $("dk-panel"); return !!(p && !p.hidden); }
  function openChat(focusInput) {
    var p = $("dk-panel"), b = $("dk-chatbtn");
    if (!p || st.focus) return;
    p.hidden = false;
    if (b) { b.setAttribute("aria-expanded", "true"); b.classList.add("on"); b.classList.remove("unread"); }
    seenAi = lastAi;
    renderChat(true);
    placeGlance();
    if (focusInput !== false) setTimeout(function () { var i = $("cc-input"); if (i && !i.closest("[hidden]")) i.focus(); }, 30);
    report(true);
  }
  function closeChat() {
    var p = $("dk-panel"), b = $("dk-chatbtn");
    if (!p || p.hidden) return;
    p.hidden = true;
    if (b) { b.setAttribute("aria-expanded", "false"); b.classList.remove("on"); }
    var a = document.activeElement;
    if (a && p.contains(a) && a.blur) a.blur();
    placeGlance();
    report(true);
  }
  var lastAi = "", seenAi = "", primed = false, bornAt = Date.now();
  function turns() { var cc = window.__joyaCC; return cc && cc.recent ? cc.recent(LOG_KEEP) : []; }
  function renderChat(force) {
    var box = $("dk-log");
    if (!box) return;
    var list = turns(), out = [];
    list.forEach(function (x) {
      // A message's files (the Command Center's attachments) are named under it.
      var me = x.me || "";
      if (x.files && x.files.length) me = (me ? me + "\n" : "") + "Attached: " + x.files.join(", ");
      if (me) out.push({ who: "me", text: me, id: "m" + x.id });
      if (x.ai) out.push({ who: "ai", text: x.ai, id: "a" + x.id });
    });
    // The newest reply: a new one while the panel is closed lights the button's dot.
    var ai = out.filter(function (b) { return b.who === "ai" && b.text !== "…"; }).pop();
    var aiSig = ai ? ai.id + ":" + ai.text.length : "";
    // What the page loaded with (the history comes in its first seconds) is not new.
    if (!primed) { seenAi = aiSig; if (aiSig || Date.now() - bornAt > 4000) primed = true; }
    lastAi = aiSig;
    var btn = $("dk-chatbtn");
    if (btn) btn.classList.toggle("unread", !chatOpen() && !!aiSig && aiSig.split(":")[0] !== seenAi.split(":")[0]);
    if (chatOpen()) seenAi = aiSig;
    var sig = out.map(function (b) { return b.id + ":" + b.text.length; }).join("|") + "|" + (ghost ? ghost.text : "");
    if (!force && sig === renderChat.sig) return;
    renderChat.sig = sig;
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var h = "";
    out.forEach(function (b) {
      h += '<div class="dk-msg ' + b.who + '"><b>' + (b.who === "ai" ? "JOYA AI" : "You") + "</b><span>" + esc(clip(b.text, 4000)) + "</span></div>";
    });
    if (ghost && ghost.text) h += '<div class="dk-msg me ghost"><b>You</b><span>' + esc(clip(ghost.text, 600)) + "…</span></div>";
    if (!h) h = '<p class="dk-empty">Nothing said yet. Type below, or hold the talk key to speak.</p>';
    box.innerHTML = h;
    if (atEnd || force) box.scrollTop = box.scrollHeight;
  }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  var cb = $("dk-chatbtn");
  if (cb) cb.addEventListener("click", function (e) { e.preventDefault(); if (chatOpen()) closeChat(); else openChat(true); });
  var px_ = $("dk-panel-x");
  if (px_) px_.addEventListener("click", function (e) { e.preventDefault(); closeChat(); });
  // A click outside the panel closes it (where the window lets clicks through, they never reach here anyway).
  document.addEventListener("pointerdown", function (e) {
    if (!chatOpen() || !e.target.closest) return;
    if (e.target.closest("#dk-panel, #dk-chatbtn, .cc-need, .cc-toast, .cc-pop, .cc-smenu, .cc-sdlg-back, .cc-modal, .cc-palette, [role=menu], [role=dialog]")) return;
    closeChat();
  }, true);
  document.addEventListener("joya-turns", function () { renderChat(false); });

  /* ---------------------------------------------------------------- the glance cards (0.1.9)
     Beside the core: the approvals waiting (Approve goes through the same call as every approval card,
     so the server asks for Windows Hello first -- step-up.js -- and refuses without it; Deny; Open shows
     the decision card), the sessions (working / waiting on you / idle, the names that matter, a click
     opens one), today's tokens against the tightest daily cap, and the live alerts (from the Command
     Center's own event log). What they show comes from the page's live state (the event stream);
     only the caps are read on their own, once a minute (/joya-ai/api/caps). In Floating they stand
     beside the box, on the side away from the screen's edge (the app widens the window for them); in
     the Desktop layer beside the core, or pinned where they were dropped (remembered per monitor by
     the app); never in focus mode. Shown or hidden from the tray, the app's Settings, the small button
     on the core's rim, or their own X. Pure parts: public/joya-desktop-glance.js. */
  var GL = window.JoyaGlance;
  var glCaps = null, glCapsAt = 0, glBusy = {}, glErr = {}, glSeen = null, glDrag = null, glLiveSaid = "";
  var glEl = $("dk-glance"), glBox = $("dk-gl-cards"), glBtn = $("dk-glbtn");
  // What the page loads with in its first seconds (the history, the caps) is not news: no glow, no slide-in.
  function glPrimed() { return Date.now() - bornAt > 4000; }
  function glOn() { return !!(L && L.glance) && !st.focus && !!glEl; }
  /** Place the column and the rim button where the layout says; hide the column under an open chat panel that it would cover. */
  function placeGlance() {
    if (glBtn) {
      var b = L && L.glanceBtn;
      glBtn.hidden = !b || !$("cc");
      if (b) place(glBtn, b.x - b.d / 2, b.y - b.d / 2, b.d, b.d);
      glBtn.setAttribute("aria-pressed", String(!!st.glance));
      var lab = st.glance ? "Hide the glance cards" : "Show the glance cards";
      if (glBtn.getAttribute("aria-label") !== lab) { glBtn.setAttribute("aria-label", lab); glBtn.title = lab; }
      glBtn.classList.toggle("on", !!st.glance);
    }
    if (!glEl) return;
    var on = glOn();
    glEl.hidden = !on;
    if (!on) return;
    var g = L.glance;
    if (!glCapsAt) loadCaps(true); // the first time they show
    if (!glDrag) place(glEl, g.x, g.y, g.w, g.h);
    glEl.setAttribute("data-align", g.align);
    glEl.setAttribute("data-side", g.side);
    glEl.classList.toggle("pinned", !!g.pinned);
    var pin = $("dk-gl-pin"), grip = $("dk-gl-grip");
    var desk = st.mode === "desktop";
    if (pin) {
      pin.hidden = !desk;
      pin.setAttribute("aria-pressed", String(!!g.pinned));
      var pl = g.pinned ? "Unpin: back beside JOYA AI" : "Pin here on the desktop";
      if (pin.title !== pl) { pin.title = pl; pin.setAttribute("aria-label", g.pinned ? "Unpin the cards: back beside JOYA AI" : "Pin the cards here on the desktop"); }
    }
    if (grip) {
      // On the desktop the header moves the cards (drag, or the arrow keys); elsewhere it is only a title.
      if (desk) { grip.setAttribute("tabindex", "0"); grip.setAttribute("role", "button"); grip.setAttribute("aria-label", "Move the cards: drag, or use the arrow keys"); }
      else { grip.removeAttribute("tabindex"); grip.removeAttribute("role"); grip.removeAttribute("aria-label"); }
    }
    // A small screen: the chat panel, when open, may sit where the cards are; they step aside while it is open.
    var p = $("dk-panel"), under = false;
    if (p && !p.hidden && L.panel) {
      var a = L.panel;
      under = !(g.x + g.w <= a.x || a.x + a.w <= g.x || g.y + g.h <= a.y || a.y + a.h <= g.y) && overlapsCards(a);
    }
    glEl.classList.toggle("dk-gl-under", under);
    renderGlance(false);
  }
  function overlapsCards(a) {
    var cs = glEl.querySelectorAll(".dk-gl-hit");
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      if (r.width && !(r.right <= a.x || a.x + a.w <= r.left || r.bottom <= a.y || a.y + a.h <= r.top)) return true;
    }
    return false;
  }

  function setGlance(on) {
    on = !!on;
    if (st.glance === on) return;
    st.glance = on;
    invoke("set_glance", { show: on });
    apply(); // at once here; the app resizes the Floating window and confirms with its state
    if (on) loadCaps(true);
  }
  function setPin(p) {
    st.glancePin = p;
    if (T) invoke("set_glance", p ? { pin: p } : { unpin: true });
    else { try { if (p) window.localStorage.setItem("joya-desk-glance-pin", JSON.stringify(p)); else window.localStorage.removeItem("joya-desk-glance-pin"); } catch (e) { /* not remembered */ } }
    layout();
  }
  function pinHere(x, y) { return { x: Math.max(0, Math.min(0.98, x / L.W)), y: Math.max(0, Math.min(0.95, y / L.H)) }; }

  /* The caps: once a minute while the cards show (the Command Center's own status poll is every 30 s). */
  function loadCaps(now) {
    if (!glOn() || !$("cc") || document.hidden) return;
    if (!now && Date.now() - glCapsAt < 55000) return;
    glCapsAt = Date.now();
    try {
      fetch("/joya-ai/api/caps", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && Array.isArray(j.sessions)) { glCaps = j; renderGlance(true); } })
        .catch(function () { /* the card says what it has */ });
    } catch (e) { /* no fetch */ }
  }
  setInterval(function () { loadCaps(false); }, 60000);

  /* ---- drawing: one keyed element per card, redrawn only when its own text changes (focus kept) ---- */
  function svgI(d) { return '<svg class="cc-i" viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>"; }
  var I_SHIELD = svgI('<path d="M12 3.5 5 6.5v5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9v-5z"/><path d="m9 12 2.2 2.2L15.5 10"/>');
  function apCard(a, more) {
    var busy = glBusy[a.id], err = glErr[a.id];
    var h = '<article class="dk-gl-card dk-gl-ap dk-gl-hit" role="group" aria-label="' + esc("Approval waiting, from " + a.who + ": " + a.what) + '">' +
      '<div class="dk-gl-k"><i class="dk-gl-dot warn" aria-hidden="true"></i><span>Needs you · ' + esc(a.who) + '</span><span class="sp"></span>' +
      (a.leftText ? '<time class="dk-gl-left' + (a.low ? " low" : "") + '" data-gl-left="' + a.id + '" aria-label="' + esc(a.leftText + " left, then denied") + '">' + esc(a.leftText) + "</time>" : "") + "</div>" +
      '<p class="dk-gl-sum">' + esc(a.what) + "</p>" +
      (busy ? '<p class="dk-gl-note" role="status">' + (busy === "approve" ? I_SHIELD + "Confirm it is you…" : "Denying…") + "</p>" : "") +
      (err ? '<p class="dk-gl-err" role="alert">' + esc(err) + "</p>" : "") +
      '<div class="dk-gl-acts">' +
      '<button type="button" class="dk-gl-b pri" data-gl-approve="' + a.id + '" data-gl-fid="ap' + a.id + 'a" title="Approve (Windows Hello first)"' + (busy ? " disabled" : "") + ">" + I_SHIELD + "Approve</button>" +
      '<button type="button" class="dk-gl-b" data-gl-deny="' + a.id + '" data-gl-fid="ap' + a.id + 'd"' + (busy ? " disabled" : "") + ">Deny</button>" +
      '<span class="sp"></span><button type="button" class="dk-gl-b link" data-gl-open="' + a.id + '" data-gl-fid="ap' + a.id + 'o" title="The whole card: what it runs, why, always-allow">Open</button></div>' +
      (more ? '<button type="button" class="dk-gl-more" data-gl-more data-gl-fid="apmore">+' + more + " more waiting</button>" : "") +
      "</article>";
    return { key: "ap" + a.id, sig: [a.id, a.who, a.what, a.low ? 1 : 0, !!a.leftText, busy || "", err || "", more].join("|"), html: h };
  }
  function noApCard() {
    return { key: "ap-none", sig: "none", html: '<article class="dk-gl-card dk-gl-quiet dk-gl-hit" role="group" aria-label="Approvals: none waiting"><div class="dk-gl-k"><i class="dk-gl-dot ok" aria-hidden="true"></i><span>No approvals waiting</span></div></article>' };
  }
  function sessCard(x) {
    var label = "Sessions: " + x.working + " working, " + x.waiting + " waiting on you, " + x.idle + " idle";
    var h = '<article class="dk-gl-card dk-gl-se dk-gl-hit" role="group" aria-label="' + esc(label) + '">' +
      '<div class="dk-gl-k"><span>Sessions</span><span class="sp"></span><button type="button" class="dk-gl-b link" data-gl-sheet="sessions" data-gl-fid="se-all" aria-label="All sessions">All</button></div>' +
      '<div class="dk-gl-counts" aria-hidden="true"><span class="w"><b>' + x.working + "</b>working</span><span class=\"a\"><b>" + x.waiting + "</b>waiting on you</span><span class=\"i\"><b>" + x.idle + "</b>idle</span></div>" +
      (x.top.length ? '<ul class="dk-gl-names">' + x.top.map(function (t) {
        return '<li><button type="button" data-gl-sess="' + esc(t.key) + '" data-gl-fid="se-' + esc(t.key) + '" aria-label="' + esc("Open " + t.name + ", " + t.note) + '"><i class="dk-gl-dot ' + (t.state === "waiting" ? "warn" : t.state === "working" ? "work" : "idle") + '" aria-hidden="true"></i><span class="nm">' + esc(t.name) + "</span><small>" + esc(t.note) + "</small></button></li>";
      }).join("") + "</ul>" : '<p class="dk-gl-empty">No sessions running.</p>') + "</article>";
    return { key: "se", sig: h, html: h };
  }
  function costCard(c) {
    var label = "Today: " + (c.known ? c.totalText + " tokens" : "not known yet") + (c.capText ? ". " + c.capText : "") + (c.stateText ? ", " + c.stateText : "");
    var h = '<article class="dk-gl-card dk-gl-co dk-gl-hit tone-' + c.tone + '" role="group" aria-label="' + esc(label) + '">' +
      '<div class="dk-gl-k"><span>Today</span><span class="sp"></span>' + (c.usdText ? '<small title="API-equivalent estimate of today\'s use">' + esc(c.usdText) + "</small>" : "") +
      '<button type="button" class="dk-gl-b link" data-gl-sheet="cost" data-gl-fid="co-more" aria-label="Usage">Usage</button></div>' +
      '<div class="dk-gl-big" aria-hidden="true"><b>' + esc(c.known ? c.totalText : "—") + "</b><span>tokens</span>" + (c.stateText ? '<em>' + esc(c.stateText) + "</em>" : "") + "</div>" +
      (c.pct != null ? '<div class="dk-gl-bar" aria-hidden="true"><i data-gl-pct="' + c.pct.toFixed(3) + '"></i></div>' : "") +
      (c.capText ? '<div class="dk-gl-sub" aria-hidden="true">' + esc(c.capText) + "</div>" : "") + "</article>";
    return { key: "co", sig: h, html: h };
  }
  function alertCard(list) {
    var h = '<article class="dk-gl-card dk-gl-al dk-gl-hit" role="group" aria-label="Live alerts">' +
      '<div class="dk-gl-k"><span>Live</span><span class="sp"></span><button type="button" class="dk-gl-b link" data-gl-sheet="dec" data-gl-fid="al-log" aria-label="The event log">Log</button></div>' +
      (list.length ? '<ul class="dk-gl-alerts">' + list.map(function (a) {
        return '<li class="t-' + a.tone + (glSeen && glPrimed() && !glSeen[a.key] ? " new" : "") + '"><i class="dk-gl-dot ' + a.tone + '" aria-hidden="true"></i><span>' + esc(a.text) + "</span>" + (a.ago ? "<time>" + esc(a.ago) + "</time>" : "") + "</li>";
      }).join("") + "</ul>" : '<p class="dk-gl-empty">Nothing new. Sessions finishing, waiting on you or failing show here.</p>') + "</article>";
    return { key: "al", sig: list.map(function (a) { return a.key + a.ago; }).join("|") + "|" + (list.length ? "" : "e"), html: h };
  }
  /* Proactive JOYA AI's card (public/joya-proactive.js): the morning brief or "while you were away", on top,
     until dismissed (here, in the Command Center or from another device). Four lines, the rest behind "More". */
  var paOpen = {};
  function paCard(b) {
    var open = !!paOpen[b.id], lines = open ? b.lines : b.lines.slice(0, 4), more = b.lines.length - lines.length;
    var label = b.title + ". " + b.lines.map(function (l) { return l.k + ": " + l.text; }).join(". ");
    var h = '<article class="dk-gl-card dk-gl-pa dk-gl-hit' + (b.kind === "catchup" ? " catchup" : "") + '" role="group" aria-label="' + esc(clip(label, 600)) + '">' +
      '<div class="dk-gl-k"><i class="dk-gl-dot ' + (b.lines.some(function (l) { return l.tone === "warn" || l.tone === "err"; }) ? "warn" : "ok") + '" aria-hidden="true"></i><span>' + esc(b.kind === "catchup" ? "While you were away" : "Morning brief") + '</span><span class="sp"></span>' +
      (b.at ? "<time>" + esc(b.at) + "</time>" : "") + "</div>" +
      '<ul class="dk-gl-pa-lines">' + lines.map(function (l) { return '<li class="t-' + esc(l.tone) + '"><b>' + esc(l.k) + "</b> " + esc(l.text) + "</li>"; }).join("") + "</ul>" +
      '<div class="dk-gl-acts"><button type="button" class="dk-gl-b" data-gl-pa-dismiss="' + b.id + '" data-gl-fid="pa' + b.id + 'x">Dismiss</button>' +
      (more > 0 || open ? '<span class="sp"></span><button type="button" class="dk-gl-b link" data-gl-pa-more="' + b.id + '" data-gl-fid="pa' + b.id + 'm" aria-expanded="' + open + '">' + (open ? "Less" : "+" + more + " more") + "</button>" : "") + "</div></article>";
    return { key: "pa" + b.id, sig: h, html: h };
  }
  function syncCards(box, cards) {
    var have = {}, kids = box.children, i;
    for (i = 0; i < kids.length; i++) have[kids[i].getAttribute("data-gl-key")] = kids[i];
    var ae = document.activeElement, fid = ae && box.contains(ae) ? ae.getAttribute("data-gl-fid") : null;
    cards.forEach(function (c, idx) {
      var el = have[c.key];
      delete have[c.key];
      if (!el || el.getAttribute("data-gl-sig") !== c.sig) {
        var t = document.createElement("template");
        t.innerHTML = c.html;
        var n = t.content.firstElementChild;
        n.setAttribute("data-gl-key", c.key);
        n.setAttribute("data-gl-sig", c.sig);
        if (!el && glSeen && glPrimed()) n.classList.add("dk-gl-in");
        if (el) box.replaceChild(n, el);
        el = n;
      }
      if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    });
    Object.keys(have).forEach(function (k) { if (have[k] && have[k].parentNode === box) box.removeChild(have[k]); });
    // The bar's length (the CSSOM: no inline style in the markup).
    var bars = box.querySelectorAll("[data-gl-pct]");
    for (i = 0; i < bars.length; i++) bars[i].style.transform = "scaleX(" + bars[i].getAttribute("data-gl-pct") + ")";
    if (fid && document.activeElement !== box.querySelector('[data-gl-fid="' + fid + '"]')) {
      var f = box.querySelector('[data-gl-fid="' + (window.CSS && CSS.escape ? CSS.escape(fid) : fid) + '"]');
      if (f && !f.disabled) f.focus();
    }
  }
  function renderGlance(force) {
    if (!GL || !glBox || !glOn()) return;
    var cc = window.__joyaCC, S = cc && cc.S;
    if (!S) return;
    var now = cc.now ? cc.now() : Date.now();
    var aps = [];
    if (S.approvals && S.approvals.forEach) S.approvals.forEach(function (a) { aps.push(a); });
    var A = GL.approvals(aps, now), al = GL.alerts(S.feed, now);
    var cards = [];
    var PA = window.JoyaProactive, pa = PA && PA.current ? PA.current() : null;
    if (pa) cards.push(paCard(pa));
    // While the big decision card is open, the approval cards step back (it shows the same thing, larger);
    // they come back when it closes. The other cards stay.
    if (!bigCardOpen()) {
      A.list.forEach(function (a, i) { cards.push(apCard(a, i === A.list.length - 1 ? A.more : 0)); });
      if (!A.total) cards.push(noApCard());
    }
    cards.push(sessCard(GL.sessions(S.sessions)));
    cards.push(costCard(GL.cost(glCaps, S.status)));
    cards.push(alertCard(al));
    syncCards(glBox, cards);
    // A screen reader hears what is new (one polite line), not the whole column again.
    var said = A.list.length ? "a" + A.list[0].id : al.length ? al[0].key : "";
    if (glSeen && said && said !== glLiveSaid) {
      var lv = $("dk-gl-live");
      if (lv) lv.textContent = A.list.length && said.charAt(0) === "a" ? A.list[0].who + " needs your approval: " + A.list[0].what : al[0].text;
    }
    glLiveSaid = said;
    var seen = {};
    al.forEach(function (a) { seen[a.key] = 1; });
    if (glSeen) Object.keys(glSeen).forEach(function (k) { seen[k] = 1; });
    glSeen = seen; // what was there from the start is not "new"
    if (force) report(false);
  }
  /* The countdown on each approval card, once a second (no redraw). */
  setInterval(function () {
    if (!glOn() || !glBox) return;
    var cc = window.__joyaCC, S = cc && cc.S, now = cc && cc.now ? cc.now() : Date.now();
    var ts = glBox.querySelectorAll("[data-gl-left]");
    for (var i = 0; i < ts.length; i++) {
      var a = S && S.approvals && S.approvals.get(Number(ts[i].getAttribute("data-gl-left")));
      if (!a) continue;
      var left = Math.max(0, (Date.parse(a.expires_at) - now) / 1000);
      if (!isFinite(left)) continue;
      var t = GL.mmss(left);
      if (ts[i].textContent !== t) ts[i].textContent = t;
      if (left < 60 && !ts[i].classList.contains("low")) renderGlance(false);
    }
  }, 1000);
  ["joya-cc", "joya-needs", "joya-turns", "joya-proactive"].forEach(function (n) { document.addEventListener(n, function () { renderGlance(false); }); });
  /* The big decision card (#cc-need) opening or closing: the approval cards step back / return at once. */
  function bigCardOpen() { var n = $("cc-need"); return !!(n && !n.hidden); }
  (function () {
    var n = $("cc-need");
    if (n && window.MutationObserver) new MutationObserver(function () { renderGlance(true); }).observe(n, { attributes: true, attributeFilter: ["hidden"] });
  })();
  // A slow guard: the "N min ago" times move on, and anything an event did not announce.
  setInterval(function () { renderGlance(false); }, 15000);

  /* ---- what the cards do ---- */
  function glDecide(id, how) {
    var cc = window.__joyaCC;
    if (!cc || glBusy[id]) return;
    glBusy[id] = how;
    delete glErr[id];
    renderGlance(true);
    var go = how === "approve" ? cc.approve(id) : cc.decide(id, "deny");
    Promise.resolve(go).then(function () {
      delete glBusy[id];
      renderGlance(true);
    }, function (e) {
      delete glBusy[id];
      var m = (e && e.message) || "it did not go through";
      glErr[id] = /^Not (approved|denied)/.test(m) ? m : (how === "approve" ? "Not approved: " : "Not denied: ") + m;
      renderGlance(true);
    });
  }
  if (glEl) glEl.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("button") : null;
    if (!t || t.disabled) return;
    var cc = window.__joyaCC;
    var v;
    if ((v = t.getAttribute("data-gl-approve"))) return glDecide(Number(v), "approve");
    if ((v = t.getAttribute("data-gl-deny"))) return glDecide(Number(v), "deny");
    if ((v = t.getAttribute("data-gl-open"))) { if (cc && cc.openNeed) cc.openNeed(Number(v)); return; }
    if (t.hasAttribute("data-gl-more")) { if (cc && cc.openNeed) cc.openNeed(); return; }
    if ((v = t.getAttribute("data-gl-sess"))) { if (cc && cc.openSession) cc.openSession(v); return; }
    if ((v = t.getAttribute("data-gl-sheet"))) { if (cc && cc.openSheet) cc.openSheet(v); return; }
    if ((v = t.getAttribute("data-gl-pa-dismiss"))) { if (window.JoyaProactive) window.JoyaProactive.dismiss(Number(v)); return; }
    if ((v = t.getAttribute("data-gl-pa-more"))) { paOpen[v] = !paOpen[v]; renderGlance(true); return; }
    v = t.getAttribute("data-gl");
    if (v === "hide") { setGlance(false); if (glBtn && !glBtn.hidden) glBtn.focus(); return; }
    if (v === "pin" && L && L.glance) { setPin(L.glance.pinned ? null : pinHere(L.glance.x, L.glance.y)); return; }
  });
  if (glBtn) glBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); setGlance(!st.glance); });

  /* ---- moving the cards on the desktop: drag the header, or the arrow keys on it; where they stop, they are pinned ---- */
  var grip = $("dk-gl-hd");
  if (grip) {
    grip.addEventListener("pointerdown", function (e) {
      if (st.mode !== "desktop" || e.button !== 0 || !L || !L.glance || (e.target.closest && e.target.closest("button"))) return;
      e.preventDefault();
      var r = glEl.getBoundingClientRect();
      glDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: r.left, y: r.top, moved: false, id: e.pointerId };
      try { grip.setPointerCapture(e.pointerId); } catch (x) { /* the window still has it */ }
      glEl.classList.add("dragging");
      report(true); // the whole window catches the mouse while it moves
    });
    grip.addEventListener("pointermove", function (e) {
      if (!glDrag) return;
      var w = glEl.offsetWidth;
      glDrag.x = Math.max(8, Math.min(L.W - w - 8, e.clientX - glDrag.dx));
      glDrag.y = Math.max(8, Math.min(L.H - 140, e.clientY - glDrag.dy));
      glDrag.moved = true;
      glEl.style.left = px(glDrag.x);
      glEl.style.top = px(glDrag.y);
    });
    var drop = function () {
      if (!glDrag) return;
      var d = glDrag;
      glDrag = null;
      glEl.classList.remove("dragging");
      if (d.moved) setPin(pinHere(d.x, d.y));
      report(true);
    };
    grip.addEventListener("pointerup", drop);
    grip.addEventListener("pointercancel", drop);
    grip.addEventListener("keydown", function (e) {
      if (st.mode !== "desktop" || !L || !L.glance || e.target !== $("dk-gl-grip")) return;
      var k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!k) return;
      e.preventDefault();
      var step = e.shiftKey ? 64 : 16;
      setPin(pinHere(L.glance.x + k[0] * step, L.glance.y + k[1] * step));
      var g = $("dk-gl-grip");
      if (g) g.focus();
    });
  }

  /* ---------------------------------------------------------------- the live-call button (and the app's live key)
     Not on a call: starts a hands-free live call, as a tap of the mic does. On one: ends it, as the voice
     bar's red X does. A warm hold-to-talk call is not a live one: the button starts a live call in its place. */
  var liveB = $("dk-livebtn");
  function liveMode() { var lv = window.__joyaLive; return lv && lv.mode ? lv.mode() : lv && lv.active && lv.active() ? "live" : ""; }
  function liveToggle() {
    var lv = window.__joyaLive;
    if (!lv || !lv.ok || !lv.ok()) return false;
    var m = liveMode();
    if (m === "live") return lv.end("button");
    if (m === "ptt") { lv.end("button"); setTimeout(function () { if (!liveMode()) lv.toggle(); }, 500); return true; }
    return lv.toggle();
  }
  function paintLiveBtn() {
    if (!liveB) return;
    var lv = window.__joyaLive, ok = !!(lv && lv.ok && lv.ok()), on = liveMode() === "live";
    liveB.hidden = !ok;
    liveB.classList.toggle("on", on);
    var t = on ? "End conversation" : "Start a live conversation" + (st.liveKey ? " (" + st.liveKey + ")" : "");
    if (liveB.title !== t) { liveB.title = t; liveB.setAttribute("aria-label", on ? "End conversation" : "Start a live conversation"); }
  }
  if (liveB) {
    liveB.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); liveToggle(); setTimeout(paintLiveBtn, 50); });
    setInterval(paintLiveBtn, 250);
    paintLiveBtn();
  }
  listen("joya://live", function () { liveToggle(); setTimeout(paintLiveBtn, 50); });

  /* ---------------------------------------------------------------- listening: on the state pill only
     No voice bar while the panel is closed: the pill reads "Listening" (joya-ai.js) and a small
     meter in it follows the microphone's level. */
  var capSt = $("cc-cap-state"), meter = null;
  if (capSt) {
    meter = document.createElement("span");
    meter.className = "dk-meter";
    meter.setAttribute("aria-hidden", "true");
    meter.innerHTML = "<i></i><i></i><i></i><i></i>";
    capSt.appendChild(meter);
    var bars = meter.children, ph = 0;
    setInterval(function () {
      if (capSt.getAttribute("data-s") !== "listening") return;
      var lv = window.__joyaLive, l = lv && lv.level ? Math.min(1, (lv.level() || 0) * 4) : 0;
      ph += 0.9;
      for (var i = 0; i < bars.length; i++) bars[i].style.transform = "scaleY(" + (0.25 + 0.75 * l * (0.6 + 0.4 * Math.abs(Math.sin(ph + i * 1.3)))).toFixed(2) + ")";
    }, 90);
  }
  document.addEventListener("joya-live-caption", function (e) {
    var d = (e && e.detail) || {};
    ghost = d.who === "you" && d.text && !d.final ? { text: d.text } : null;
    renderChat();
  });

  /* ---------------------------------------------------------------- click-through: what catches the mouse */
  // The chat button always; the chat panel (and the composer in it) only while it is open (a hidden element is skipped).
  var HIT = [
    "#dk-livebtn", "#dk-chatbtn", "#dk-panel", "#cc-cap-state", "#cc-cap-more", "#cc-need", "#dk-tools", "#cc-kids > *",
    "#cc-reply", "#cc-pop", "#cc-kcard.on", ".cc-smenu", ".cc-toast", ".dk-auth .auth-wrap .card", "#dk-gate", "#cc-offline", "#cc-needpill",
    // The glance cards: each card and the column's header bar -- never the column itself, so the gaps between them let clicks through.
    "#dk-glbtn", "#dk-glance:not(.dk-gl-under) .dk-gl-hit",
    // The living canvas (joya-canvas.js): each widget card beside the core (never the column itself).
    "#cv-board:not(.cv-under) .cv-w",
    // Eye contact's "Camera on" pill (joya-presence.js): its Off button must be clickable in the app too.
    "#mp-cam",
  ];
  // Open over everything: the whole window catches the mouse while one shows.
  // (#cc-overlay holds the conversation of a session -- the deep view -- and the forms: the whole window while one is open.)
  var FULL = ["#cc-overlay > *", ".cc-sdlg-back", ".cc-modal:not([hidden])", "#cc-sheet.open", ".cc-palette:not([hidden])", "#md-frame:not([hidden])"];
  function shown(el) {
    if (!el || el.hidden) return false;
    var r = el.getClientRects();
    if (!r.length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  }
  function present(el) {
    if (!el || el.hidden || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  // Eye contact's "Camera on" pill out on the desk (companion mode): added to the bot's own regions, so its Off button works there too.
  function withCam(regs) {
    var cam = document.getElementById("mp-cam");
    if (!cam || !shown(cam) || document.documentElement.classList.contains("dk-comp-faded")) return regs;
    var pr = cam.getBoundingClientRect();
    if (!(pr.width > 0 && pr.height > 0)) return regs;
    var rad = parseFloat(getComputedStyle(cam).borderTopLeftRadius) || 0;
    return regs.concat([{ x: Math.max(0, Math.floor(pr.left)), y: Math.max(0, Math.floor(pr.top)), w: Math.ceil(pr.width), h: Math.ceil(pr.height), r: Math.round(Math.min(rad, pr.height / 2)) }]);
  }
  function measure() {
    if (!L) return [];
    // Companion out: the bot (and the "Camera on" pill), nothing else.
    if (compOut() && comp) return withCam(comp.regions().map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h, r: r.r }; }));
    var full = peekish() && st.peekOpen;
    // (Open counts from the first frame: an overlay fading in is already there to be clicked.)
    if (!full) for (var f = 0; f < FULL.length; f++) { var fe = document.querySelectorAll(FULL[f]); for (var j = 0; j < fe.length; j++) if (present(fe[j])) { full = true; break; } if (full) break; }
    // Dragging the pinned cards: the whole window, so the drag never falls through to the desktop as it goes.
    if (glDrag) full = true;
    if (full) return LAY.regions(L, [], { all: true });
    var els = [];
    // The glance column scrolls when its cards are taller than it (a morning brief over two approvals at
    // 125 / 150 %): a card it cuts catches the mouse only where it shows, never in the strip below the column.
    var col = glEl && !glEl.hidden ? glEl.getBoundingClientRect() : null;
    for (var i = 0; i < HIT.length; i++) {
      var list = document.querySelectorAll(HIT[i]);
      for (var k = 0; k < list.length; k++) {
        if (!shown(list[k])) continue;
        var r = list[k].getBoundingClientRect();
        var rad = parseFloat(getComputedStyle(list[k]).borderTopLeftRadius) || 0;
        var top = r.top, bottom = r.bottom;
        if (col && glEl.contains(list[k])) { top = Math.max(top, col.top); bottom = Math.min(bottom, col.bottom); if (bottom - top < 1) continue; }
        els.push({ left: r.left, top: top, width: r.width, height: bottom - top, r: Math.min(rad, (bottom - top) / 2, r.width / 2) });
      }
    }
    // The session spheres the core draws (no DOM of their own): a circle each.
    var cc = window.__joyaCC, fam = cc && cc.orbit && cc.orbit.family;
    if (fam && fam.enabled && fam.enabled() && !st.focus) {
      var mk = fam.meshKids ? fam.meshKids() : null;
      (mk || []).forEach(function (q) { if (q && q.r > 2 && (q.form == null || q.form > 0.3)) { var h = q.r * 1.25 + 8; els.push({ left: q.x - h, top: q.y - h, width: 2 * h, height: 2 * h, r: h }); } }); // the family's own hover radius (cc-family.js hit)
    }
    // The core is a circle that catches the mouse; the sign-in pages have no core.
    return LAY.regions($("cc") ? L : { W: L.W, H: L.H, R: 0 }, els);
  }
  /* ---------------------------------------------------------------- real blur behind the glass surfaces
     When the app draws real blur (st.glass: Windows 10 1809+ / 11, transparency effects on, the setting
     on), it puts a native acrylic window under each surface reported here (set_blur_rects, CSS px, only
     settled ones -- JoyaDesktopLayout.glass -- and only when the list changes). A surface gets its lighter
     glass tint (data-dk-glass, joya-desktop.css) only once its blur is there; until then, and whenever
     there is no blur, it keeps the tinted look. Only surfaces that do not move: the session-name pills
     follow their spheres and stay tinted. Every one of them is also a hit region (HIT / FULL above), so
     the cursor over a blur window is always the page's. The approval card keeps a near-solid tint. */
  var GLASS = [
    ["#dk-panel", "card"], ["#cc-need", "alert"], ["#cc-cap-state", "pill"], ["#dk-chatbtn", "pill"], ["#dk-livebtn", "pill"],
    ["#dk-tools", "card"], [".cc-smenu", "card"], [".dk-auth .auth-wrap .card", "card"], ["#cc-offline", "card"],
    [".cc-deep", "card"], [".cc-modal:not([hidden])", "card"], [".cc-sdlg", "card"],
    // The glance cards: frosted like the panel; an approval card near-solid, like the decision card.
    ["#dk-glance:not(.dk-gl-under) .dk-gl-card:not(.dk-gl-ap)", "card"], ["#dk-glance:not(.dk-gl-under) .dk-gl-ap", "alert"], ["#dk-glance:not(.dk-gl-under) #dk-gl-hd", "pill"], ["#dk-glbtn", "pill"],
    // The living canvas's widget cards: frosted like the glance cards; an approval widget near-solid.
    ["#cv-board:not(.cv-under) .cv-w:not(.cv-ap-w)", "card"], ["#cv-board:not(.cv-under) .cv-w.cv-ap-w", "alert"],
  ];
  var glassIds = typeof WeakMap === "function" ? new WeakMap() : null, glassN = 0, glassState = null, glassSig = "", glassSent = [], glassMarked = [];
  function glassKey(el) { if (!glassIds) return null; var k = glassIds.get(el); if (!k) { k = "g" + ++glassN; glassIds.set(el, k); } return k; }
  /** Fully there: shown, and neither it nor anything round it (bar the user's own opacity on #cc) fading. */
  function solid(el) {
    if (!shown(el)) return false;
    for (var e = el; e && e !== html; e = e.parentElement) {
      if (e.id === "cc") continue;
      if (Number(getComputedStyle(e).opacity) < 0.95) return false;
    }
    return true;
  }
  /** Wholly visible: inside the window and not cut by a scrolling or clipping box round it (the glance
      column scrolls). A cut card would get a blur window hanging past what is drawn of it. Only the boxes
      that hold it (its containing blocks) can cut it: a fixed panel inside a short clipping box is not cut. */
  function unclipped(el, r) {
    if (r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) return false;
    var pos = getComputedStyle(el).position;
    for (var e = el.parentElement; e && e !== html && e !== document.body; e = e.parentElement) {
      var cs = getComputedStyle(e);
      var transformed = cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" || /paint|layout|strict|content/.test(cs.contain || "");
      if (pos === "fixed" && !transformed) continue; // not its containing block: cannot cut it
      if (pos === "absolute" && cs.position === "static" && !transformed) continue;
      pos = cs.position;
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      var c = e.getBoundingClientRect(), bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      var x0 = c.left + bl, y0 = c.top + bt, x1 = x0 + e.clientWidth, y1 = y0 + e.clientHeight;
      if (r.left < x0 - 0.5 || r.top < y0 - 0.5 || r.right > x1 + 0.5 || r.bottom > y1 + 0.5) return false;
    }
    return true;
  }
  function glassReport() {
    var rects = [], keys = [], els = {};
    if (st.glass && L) {
      var items = [];
      GLASS.forEach(function (g) {
        var list = document.querySelectorAll(g[0]);
        for (var i = 0; i < list.length; i++) {
          var el = list[i], key = glassKey(el);
          if (!key || els[key] || !solid(el)) continue;
          var r = el.getBoundingClientRect(), rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          if (!unclipped(el, r)) continue;
          els[key] = { el: el, kind: g[1] };
          items.push({ key: key, x: r.left, y: r.top, w: r.width, h: r.height, r: Math.min(rad, r.width / 2, r.height / 2) });
        }
      });
      var step = LAY.glass(glassState, items, Date.now());
      glassState = step.state;
      rects = step.rects;
      keys = step.keys;
    } else glassState = null;
    // With the viewport they were measured in: the app uses them only while its window is that size (the
    // app can resize it before the page measures again), and a new size is a new report even when the
    // rectangles read the same.
    var view = [window.innerWidth, window.innerHeight];
    var sig = JSON.stringify(rects) + "@" + view.join("x");
    if (sig !== glassSig) {
      glassSig = sig;
      glassSent = rects;
      invoke("set_blur_rects", { rects: rects, dpr: window.devicePixelRatio || 1, view: view });
    }
    // The lighter tint only where the blur now is.
    var on = keys.map(function (k) { return els[k].el; });
    glassMarked.forEach(function (el) { if (on.indexOf(el) < 0) el.removeAttribute("data-dk-glass"); });
    keys.forEach(function (k) { var o = els[k]; if (o.el.getAttribute("data-dk-glass") !== o.kind) o.el.setAttribute("data-dk-glass", o.kind); });
    glassMarked = on;
  }

  var lastRegions = [], lastSig = "", lastSent = 0;
  function report(force) {
    glassReport();
    var regs = measure();
    var sig = JSON.stringify(regs);
    if (!force && sig === lastSig) return;
    var now = Date.now();
    lastRegions = regs;
    lastSig = sig;
    lastSent = now;
    invoke("set_hit_regions", { regions: regs, dpr: window.devicePixelRatio || 1 });
  }
  setInterval(function () { report(false); }, 100);
  // A dialog, menu or overlay added (or removed) is reported at once, not at the next tick: the first click on it must land.
  try {
    var mo = new MutationObserver(function () { report(false); });
    mo.observe(document.body, { childList: true });
    var ovl = document.getElementById("cc-overlay");
    if (ovl) mo.observe(ovl, { childList: true });
  } catch (e) { /* the tick still reports */ }
  window.addEventListener("resize", function () { apply(); });

  /* ---------------------------------------------------------------- the core's state, out to the tray */
  var lastStatus = "";
  function status() {
    var cc = $("cc");
    var stt = cc ? cc.getAttribute("data-state") || "idle" : "signedout";
    var off = $("cc-offline");
    if (off && !off.hidden) stt = "offline";
    var needs = 0, n = $("cc-needn");
    if (n) needs = Number(n.textContent) || 0;
    var S = window.__joyaCC && window.__joyaCC.S;
    var sessions = S && S.sessions ? S.sessions.filter(function (s) { return !s.self; }).length : 0;
    var sig = stt + "|" + needs + "|" + sessions;
    if (sig === lastStatus) return;
    lastStatus = sig;
    invoke("set_status", { state: stt, needs: needs, sessions: sessions });
  }
  setInterval(status, 500);

  /* ---------------------------------------------------------------- needs you: the toast (the app decides when) */
  var toasted = {};
  function needsYou() {
    var cc = window.__joyaCC, S = cc && cc.S;
    if (!S || !S.approvals) return;
    S.approvals.forEach(function (a) {
      if (a.status !== "pending" || toasted[a.id]) return;
      toasted[a.id] = 1;
      var who = String(a.origin || "").replace(/^session:/, "") || "JOYA AI";
      invoke("needs_you", { id: a.id, title: (who === "JOYA AI" ? "JOYA AI" : who) + " needs you", body: clip(String(a.summary || "A step waits for your approval."), 180) + " Nothing runs until you choose." });
    });
  }
  document.addEventListener("joya-needs", needsYou);
  setInterval(needsYou, 2000);
  // The toast's Deny: the same call the card's Deny makes. (Open just shows the layer: the app does that.)
  listen("joya://toast-deny", function (p) {
    var cc = window.__joyaCC;
    // A proactive toast (a brief, a watcher) carries a negative id: its second button only dismisses it.
    if (p && Number(p.id) < 0) { if (window.JoyaProactive && window.JoyaProactive.toastDeny) window.JoyaProactive.toastDeny(Number(p.id)); return; }
    if (cc && cc.decide && p && p.id) cc.decide(Number(p.id), "deny");
  });

  /* ---------------------------------------------------------------- the app's hotkeys and state, in */
  /*
   * JOYA AI's sounds (joya-sound.js) stay quiet while the app says do-not-disturb: its own tray switch
   * ("dnd") or Windows Focus / quiet hours ("focusAssist") -- once the app sends them in its state. The
   * app (0.1.10) does not yet: then only the person's quiet hours apply.
   */
  function soundHost(p) {
    if (!p || !window.JoyaSound || (p.dnd === undefined && p.focusAssist === undefined)) return;
    window.JoyaSound.setHost({ dnd: !!p.dnd || !!p.focusAssist });
  }
  listen("joya://state", function (p) {
    soundHost(p);
    var was = JSON.stringify(st);
    STATE_KEYS.forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
    if (JSON.stringify(st) !== was) apply();
    if (p.focusComposer) setTimeout(function () { openChat(true); }, 120);
  });
  listen("joya://ptt", function (p) {
    var lv = window.__joyaLive;
    // at / seq: the app's time of the key event and its order (joya-ai.js pttKey judges taps by them).
    if (lv && lv.ptt) lv.ptt(!!p.down, typeof p.at === "number" ? p.at : undefined, typeof p.seq === "number" ? p.seq : undefined);
  });
  listen("joya://escape", function () { escape(); });
  // The tray's Talk: a hands-free live call, as a tap of the mic starts.
  listen("joya://talk", function () { var lv = window.__joyaLive; if (lv && lv.toggle && !(lv.active && lv.active())) lv.toggle(); });
  // The tray's Sign out: this device's session ends (its call too), as the avatar menu's sign-out does.
  listen("joya://signout", function () { var f = document.querySelector("form.me-logout"); if (f) f.submit(); });
  // Quit: hang up first, so the server logs why.
  listen("joya://quit", function () { var lv = window.__joyaLive; if (lv && lv.active && lv.active()) lv.end("unload"); });
  function escape() {
    // Esc in the glance cards: out of them (the next Esc does the rest).
    var ae = document.activeElement, gle = $("dk-glance");
    if (gle && ae && gle.contains(ae) && ae.blur) { ae.blur(); return; }
    if (chatOpen()) { closeChat(); return; }
    var lv = window.__joyaLive;
    if (lv && lv.active && lv.active()) { lv.end("esc"); return; }
    if (peekish()) invoke("hide_peek");
  }
  var ESC_OWNERS = ".joya-su, #cc-overlay > *, .cc-sdlg-back, .cc-modal:not([hidden]), #cc-pop:not([hidden]), .cc-smenu, .cc-sheet.open, .cc-palette:not([hidden])";
  var escOwned = false;
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    escOwned = !!document.querySelector(ESC_OWNERS);
    // The Windows Hello dialog (step-up.js) closes on Esc only with the focus in it; in the app the focus is
    // often elsewhere (Hello's own window took it and gave it back to the page): Esc cancels it all the same.
    var su = document.querySelector(".joya-su");
    if (su && !su.contains(document.activeElement)) {
      var bs = su.querySelectorAll("button");
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent.trim() === "Cancel") { e.preventDefault(); bs[i].click(); return; }
    }
  }, true);
  window.addEventListener("keydown", function (e) {
    // Esc closes the topmost thing open first (an overlay, a dialog, a menu, the sheet: their own handlers,
    // which run before this one -- so whether one was open is noted as the key goes down); only then the
    // chat panel, the call, Peek.
    if (e.key === "Escape" && !e.defaultPrevented && !escOwned) escape();
  });
  // Peek: a click on empty space sends it away (the whole window catches clicks while it shows).
  document.addEventListener("pointerdown", function (e) {
    if (!peekish() || !st.peekOpen) return;
    var t = e.target;
    if (t === document.body || t === html || t.id === "cc" || t.classList.contains("cc-main") || t.id === "cc-stage" || t.id === "cc-family" || t.tagName === "CANVAS") {
      if (!(L && Math.hypot(e.clientX - L.cx, e.clientY - L.cy) < L.R)) invoke("hide_peek");
    }
  });

  /* ---------------------------------------------------------------- the core: drag (Floating), focus the composer (others) */
  var ch = $("dk-corehit");
  if (ch) {
    ch.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (st.mode === "floating") { e.preventDefault(); invoke("start_drag"); return; }
      openChat(true);
    });
  }
  var tl = $("dk-tools");
  if (tl) tl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-dk]");
    if (!b) return;
    var v = b.getAttribute("data-dk");
    if (v === "drag") return;
    invoke("tool", { name: v });
  });
  if (tl) tl.addEventListener("pointerdown", function (e) { var b = e.target.closest("[data-dk=drag]"); if (b && e.button === 0) { e.preventDefault(); invoke("start_drag"); } });
  var full = $("dk-open-full");
  if (full) full.addEventListener("click", function (e) { e.preventDefault(); invoke("open_full_cc"); });

  /* ---------------------------------------------------------------- battery saver: a still core */
  // The app's "hold still" must stick: it used to stop the core only if it was running at that moment,
  // so a core that was paused just then (the window hidden or covered: WebView2 marks the page hidden),
  // or not started yet (the app starting on battery), was started again later by the page's own
  // visibility handler or start() -- and animated on battery. Now the core's own still flag is set
  // (its start() then draws one still frame), and a slow guard catches a core swapped in later.
  var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function still() {
    var cc = window.__joyaCC, core = cc && cc.core;
    if (!core) return;
    // Companion out: the Command Center's core rests (the companion's own bot moves instead, joya-desktop-companion.js).
    var hold = !!(st.still || st.hidden || compOut());
    if (comp) comp.applyStill();
    if (hold) {
      if (core.S) core.S.still = true;
      if (core.stop) core.stop();
      if (core.still) core.still(); else if (core.draw) core.draw();
    } else if (core.S) {
      var was = core.S.still;
      core.S.still = !!(reduceMq && reduceMq.matches);
      if ((was || !core.S.running) && core.start) core.start();
    }
  }
  setInterval(function () {
    if (!(st.still || st.hidden || compOut())) return;
    var cc = window.__joyaCC, core = cc && cc.core;
    if (core && core.S && (core.S.running || !core.S.still)) still();
  }, 2000);

  /* ---------------------------------------------------------------- sign-in: the browser hand-off */
  var bs = $("dk-browser-signin");
  if (bs) {
    if (!T) bs.hidden = true;
    bs.addEventListener("click", function (e) {
      e.preventDefault();
      bs.disabled = true;
      var note = $("dk-browser-note");
      if (note) note.textContent = "Sign in in the browser window that opened. This card comes back signed in.";
      invoke("browser_signin").then(function (r) {
        bs.disabled = false;
        if (r && r.error && note) note.textContent = r.error;
      });
    });
  }

  /* ---------------------------------------------------------------- Companion mode */
  if (CMP && CMP.mount && $("cc")) {
    comp = CMP.mount({
      invoke: invoke, listen: listen, state: function () { return st; }, still: function () { return !!(st.still || st.hidden); },
      report: function (regs) { regs = withCam(regs); lastRegions = regs; lastSig = JSON.stringify(regs); invoke("set_hit_regions", { regions: regs, dpr: window.devicePixelRatio || 1 }); },
    });
    window.JoyaDesktop.companion = function () { return comp; };
  }

  /* ---------------------------------------------------------------- boot */
  apply(); // from the address (or the defaults) at once; the app's own state follows
  function boot() {
    invoke("get_state").then(function (p) {
      if (p) STATE_KEYS.forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
      soundHost(p);
      apply();
      invoke("page_ready", { signedIn: !!$("cc") });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  setTimeout(loadCaps, 1500);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(); });
})();
