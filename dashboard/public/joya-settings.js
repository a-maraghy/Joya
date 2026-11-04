"use strict";
/*
 * Account > Appearance: the JOYA AI core, chosen with a live preview of each;
 * with core E (the bot), its face style (smooth / dots / minimal: three live thumbnails walking through the
 * states; a choice switches every bot on the page at once, JoyaBot.setFace, and an open Command Center or the
 * desktop app through the "joya-bot" storage note), its head (ten thumbnails) and colours (presets, or one
 * picker per state and the wireframe, each with its derived dark / light shade,
 * a too-close warning, the six states in both themes), saved at once through
 * POST /joya-ai/api/prefs/bot.
 *
 * Each option draws its core in a small canvas (D, the mesh, joya-core-d.js;
 * E, the bot, joya-core-bot.js; A, B and C were retired on 2026-10-25), cycling through
 * the states so the difference shows. Choosing one saves it at once through
 * the Command Center's own route (POST /joya-ai/api/prefs/core, CSRF in a
 * header), no reload; the form still posts without JavaScript. The previews
 * run only while on screen and stop when the tab is hidden.
 */
(function () {
  var form = document.getElementById("joya-appearance");
  if (!form || !(window.JoyaCoreD || window.JoyaCoreBot)) return;
  var CSRF = form.getAttribute("data-csrf") || "";
  var note = document.getElementById("joya-appearance-note");
  var CYCLE = ["idle", "listening", "thinking", "speaking", "needs", "idle"];
  var FACE_CYCLE = ["idle", "listening", "thinking", "speaking", "needs"]; // the face thumbnails walk through these
  var previews = [];
  form.classList.add("js");
  var LG = window.JoyaLogic;

  /* ------------------------------------------------------------ core E: head and colours */
  var botEl = document.getElementById("joya-bot");
  var Bot = {
    live: null,
    cur: LG && botEl ? LG.normBotColors(botEl.getAttribute("data-bot-colors") || "") : null,
    head: function () { var r = form.querySelector('input[name="bot_head"]:checked'); return r ? r.value : botEl ? botEl.getAttribute("data-bot-head") : "cap"; },
    face: function () { var r = form.querySelector('input[name="bot_face"]:checked'); return r ? r.value : botEl ? botEl.getAttribute("data-bot-face") || "smooth" : "smooth"; },
    colors: function () { return Bot.cur; },
  };
  /** Core E's section shows only while E is the chosen core. */
  function coreNow() { var r = form.querySelector('input[name="core"]:checked'); return r ? r.value : ""; }
  function paintCoreE() { form.classList.toggle("core-e", coreNow() === "E"); }
  paintCoreE();

  function isLight() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "light";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  var canvases = form.querySelectorAll("canvas[data-prev-core]");
  for (var i = 0; i < canvases.length; i++) {
    (function (cv, k) {
      var k0 = cv.getAttribute("data-prev-core");
      var core = k0 === "E" && window.JoyaCoreBot
        ? window.JoyaCoreBot(cv, { noGuard: true, head: Bot.head(), colors: Bot.colors() })
        : window.JoyaCoreD
          ? window.JoyaCoreD(cv, { autoAmp: true })
          : null;
      if (!core) return;
      if (k0 === "E") Bot.live = core;
      cv = core.canvas || cv; // a core without its GPU context draws on a fresh copy of the canvas
      var p = { cv: cv, core: core, n: k, on: false };
      p.fit = function () {
        var w = cv.clientWidth || 180, h = cv.clientHeight || 120;
        core.resize(w / 2, h / 2, Math.min(w, h) * 0.34, w, h);
      };
      core.setLight(isLight());
      p.fit();
      previews.push(p);
    })(canvases[i], i);
  }
  // Each preview walks through the states, a beat apart from the others.
  var step = 0;
  setInterval(function () {
    if (document.hidden) return;
    step++;
    previews.forEach(function (p) { p.core.setState(CYCLE[(step + p.n) % CYCLE.length]); });
    paintFaces();
  }, 2600);
  function visible(p, on) {
    if (on === p.on) return;
    p.on = on;
    if (on) p.core.start(); else p.core.stop();
  }
  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        previews.forEach(function (p) { if (p.cv === e.target) visible(p, e.isIntersecting); });
      });
    });
    previews.forEach(function (p) { io.observe(p.cv); });
  } else previews.forEach(function (p) { visible(p, true); });
  window.addEventListener("resize", function () { previews.forEach(function (p) { p.fit(); }); });
  // leaving the page (it opens in the Command Center's frame) gives the previews' GPU contexts back at once: the
  // browser keeps only about 16 and would take the Command Center's own when Settings is opened again and again
  window.addEventListener("pagehide", function (e) { if (e.persisted) return; previews.forEach(function (p) { try { p.core.destroy(); } catch (x) { /* gone already */ } }); previews.length = 0; });
  paintBot();
  function repaint() { previews.forEach(function (p) { p.core.setLight(isLight()); }); paintBot(); }

  /* ---- core E: the three faces, live: each thumbnail walks through the states in the chosen head and colours ---- */
  function paintFaces() {
    if (!botEl || !window.JoyaBot || !LG || !Bot.cur) return;
    var th = botEl.querySelectorAll("canvas[data-bot-face-thumb]"), light = isLight();
    for (var i = 0; i < th.length; i++) window.JoyaBot.thumb(th[i], Bot.head(), { state: FACE_CYCLE[(step + i) % FACE_CYCLE.length], light: light, colors: Bot.cur, w: 96, h: 96, face: th[i].getAttribute("data-bot-face-thumb") });
  }
  /* ---- core E: thumbnails (JoyaBot.thumb, 2D), swatches and shades (CSSOM: no inline style), the warning ---- */
  function paintBot() {
    if (!botEl || !window.JoyaBot || !LG || !Bot.cur) return;
    var light = isLight(), c = Bot.cur, i;
    if (window.JoyaBot.setFace && window.JoyaBot.face() !== Bot.face()) window.JoyaBot.setFace(Bot.face()); // the previews and every thumbnail below
    paintFaces();
    var th = botEl.querySelectorAll("canvas[data-bot-thumb]");
    for (i = 0; i < th.length; i++) window.JoyaBot.thumb(th[i], th[i].getAttribute("data-bot-thumb"), { state: "idle", light: light, colors: c, w: 84, h: 84 });
    var st = botEl.querySelectorAll("canvas[data-bot-state]"), FACE = { ready: "idle", listening: "listening", thinking: "thinking", speaking: "speaking", needs: "needs", error: "error" };
    for (i = 0; i < st.length; i++) window.JoyaBot.thumb(st[i], Bot.head(), { state: FACE[st[i].getAttribute("data-bot-state")], light: st[i].getAttribute("data-bot-theme") === "light", colors: c, w: 76, h: 76 });
    var sw = botEl.querySelectorAll("[data-bot-preset-opt=custom] i[data-swatch]");
    for (i = 0; i < sw.length; i++) sw[i].setAttribute("data-swatch", c.c[LG.BOT_STATE_ITEMS[i]]);
    var all = botEl.querySelectorAll("i[data-swatch]");
    for (i = 0; i < all.length; i++) all[i].style.background = all[i].getAttribute("data-swatch");
    var sh = botEl.querySelectorAll("i[data-shade]"), pd = LG.botPalette({ p: "custom", c: c.c }, false), pl = LG.botPalette({ p: "custom", c: c.c }, true);
    for (i = 0; i < sh.length; i++) {
      var kk = sh[i].getAttribute("data-shade").split(":"), rgb = (kk[1] === "light" ? pl : pd)[kk[0]];
      sh[i].style.background = LG.rgbHex(rgb);
      sh[i].title = (kk[1] === "light" ? "Light theme: " : "Dark theme: ") + LG.rgbHex(rgb);
    }
    var warn = document.getElementById("joya-bot-warn"), close = c.p === "custom" ? LG.botClosePairs(c) : [];
    if (warn) {
      warn.hidden = !close.length;
      warn.textContent = close.length ? "Hard to tell apart: " + close.map(function (p) { return LG.BOT_ITEM_LABEL[p[0]] + " and " + LG.BOT_ITEM_LABEL[p[1]]; }).join(", ") + ". The faces still differ, but the colours look alike." : "";
    }
    var cu = document.getElementById("joya-bot-custom");
    if (cu) cu.hidden = c.p !== "custom";
    if (Bot.live) { Bot.live.setHead(Bot.head()); Bot.live.setColors(c); }
  }
  function saveBot(body, what) {
    say("Saving…");
    return fetch("/joya-ai/api/prefs/bot", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        say("Saved. The bot: " + (what === "head" ? j.headName : what === "face" ? j.faceName + " face" : j.colorsName) + ".");
        // An open Command Center (another tab, or the shell round this page) takes it at once (a storage event).
        var note = JSON.stringify({ head: j.head, colors: j.colors, face: j.face, at: Date.now() });
        try { window.localStorage.setItem("joya-bot", note); } catch (x) { /* it reads the server's on its next load */ }
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  }
  function botHeadChosen(h) { paintBot(); saveBot({ head: h }, "head"); }
  function botFaceChosen(f) { paintBot(); saveBot({ face: f }, "face"); }
  function botPresetChosen(p) {
    if (p === "custom") Bot.cur = { p: "custom", c: Bot.cur.c };
    else Bot.cur = LG.normBotColors({ p: p });
    if (p === "custom") fillPickers();
    paintBot();
    saveBot({ colors: { preset: Bot.cur.p, custom: Bot.cur.p === "custom" ? Bot.cur.c : undefined } }, "colors");
  }
  function fillPickers() {
    var ins = botEl.querySelectorAll("input[data-bot-item]");
    for (var i = 0; i < ins.length; i++) ins[i].value = Bot.cur.c[ins[i].getAttribute("data-bot-item")].toLowerCase();
  }
  var botT = 0;
  /** A custom colour moved: preview at once; saved when the picker closes (change) or after a pause. */
  function botPicked(commit) {
    var ins = botEl.querySelectorAll("input[data-bot-item]"), c = {};
    for (var i = 0; i < ins.length; i++) c[ins[i].getAttribute("data-bot-item")] = ins[i].value;
    Bot.cur = LG.normBotColors({ p: "custom", c: c });
    var cr = form.querySelector('input[name="bot_preset"][value="custom"]');
    if (cr) cr.checked = true;
    paintBot();
    clearTimeout(botT);
    botT = setTimeout(function () { saveBot({ colors: { preset: "custom", custom: Bot.cur.c } }, "colors"); }, commit ? 0 : 700);
  }
  if (botEl && LG) {
    botEl.addEventListener("input", function (e) { if (e.target.getAttribute("data-bot-item")) botPicked(false); });
    var rs = document.getElementById("joya-bot-reset");
    if (rs) rs.addEventListener("click", function () {
      var from = document.getElementById("joya-bot-reset-from");
      Bot.cur = { p: "custom", c: LG.normBotColors({ p: from ? from.value : "default" }).c };
      fillPickers();
      botPicked(true);
    });
  }
  document.addEventListener("joya-theme", repaint);
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    if (mq.addEventListener) mq.addEventListener("change", repaint);
  }

  function say(text, bad) {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("err", !!bad);
  }
  form.addEventListener("change", function (e) {
    if (e.target.name === "sessions_view") return saveSessView(e.target.value);
    if (e.target.name === "bot_head") return botHeadChosen(e.target.value);
    if (e.target.name === "bot_face") return botFaceChosen(e.target.value);
    if (e.target.name === "bot_preset") return botPresetChosen(e.target.value);
    if (e.target.getAttribute && e.target.getAttribute("data-bot-item")) return botPicked(true);
    if (e.target.name !== "core") return;
    paintCoreE();
    var core = e.target.value;
    say("Saving…");
    fetch("/joya-ai/api/prefs/core", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify({ core: core }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        try { window.localStorage.setItem("joya-core", j.core); } catch (x) { /* the server keeps it */ }
        say("Saved. The Command Center uses " + j.core + " · " + j.name + ".");
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  });
  /* The sessions view: saved at once through the Command Center's own route, like the core. */
  function saveSessView(view) {
    say("Saving…");
    fetch("/joya-ai/api/prefs/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify({ view: view }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        say("Saved. The Command Center shows the sessions as " + j.name + ".");
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  }
  form.addEventListener("submit", function (e) {
    // With JavaScript the choice is saved as it is made.
    e.preventDefault();
  });
})();
