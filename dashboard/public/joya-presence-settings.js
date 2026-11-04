"use strict";
/*
 * Settings > Appearance > Eye contact (2026-10-20): camera presence's switches (lib/routes-settings.js
 * presenceSettings). In a browser they are this browser's own (localStorage "joya-presence", never sent; an
 * open Command Center follows through the storage event). In the JOYA AI app they show the app's setting:
 * ON is only possible from the app's Settings window or its tray (the app refuses the page), OFF works here
 * (presence_off). This page never opens the camera to look through it.
 *
 * The camera (2026-10-21): Automatic or one of this computer's cameras, by name (localStorage
 * "joya-presence-camera" = { id, label } -- in the browser and in the app alike, never sent; the open Command
 * Center switches at once). The names are only shown once the camera has been allowed: then the button
 * "Allow the camera once" asks for it and lets go at once (it does so by itself only while eye contact is on).
 * Under it, the camera in use and why, if the chosen one could not be used (the camera module's
 * "joya-presence-cam-used").
 */
(function () {
  var box = document.getElementById("mp-set");
  var L = window.JoyaPresenceLogic;
  if (!box || !L) return;
  var KEY = "joya-presence";
  var T = window.__TAURI__ || null;
  var APP = !!(T && T.core && T.core.invoke);
  var note = document.getElementById("mp-note");
  function el(k) { return box.querySelector('[data-mp="' + k + '"]'); }
  function say(t) { if (note) note.textContent = t; }
  var stateEl = box.querySelector("[data-mp-state]"), offBtn = box.querySelector("[data-mp-off]");
  box.classList.toggle("mp-app", APP);
  box.querySelectorAll(".scope").forEach(function (s) { if (APP) s.textContent = "this computer"; });

  var camOn = false;

  /* ---------------------------------------------------------------- which camera */
  var CAMKEY = "joya-presence-camera", USED = "joya-presence-cam-used";
  var sel = box.querySelector("[data-mp-camsel]"), hint = box.querySelector("[data-mp-camhint]"), allowBtn = box.querySelector("[data-mp-allow]"), usedEl = box.querySelector("[data-mp-camused]");
  var MD = navigator.mediaDevices || null, asked = false, labels = {};
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function choice() { return L.normCamChoice(lsGet(CAMKEY)); }
  function opt(v, t) { var o = document.createElement("option"); o.value = v; o.textContent = t; return o; }
  function devices() { return MD && MD.enumerateDevices ? MD.enumerateDevices().then(function (l) { return (l || []).filter(function (d) { return d.kind === "videoinput"; }); }, function () { return []; }) : Promise.resolve([]); }
  function showUsed() {
    if (!usedEl) return;
    var u = null; try { u = JSON.parse(lsGet(USED) || "null"); } catch (e) { u = null; }
    var t = "", warn = false;
    if (u && u.label && camOn) { t = "Last used: " + u.label + (u.how === "auto" ? " (automatic)" : ""); if (u.note) { t = u.note + ". " + t; warn = true; } }
    usedEl.textContent = t;
    usedEl.classList.toggle("warn", warn);
  }
  function list() {
    if (!sel) return Promise.resolve();
    return devices().then(function (cams) {
      var c = choice(), named = cams.filter(function (d) { return d.deviceId && L.camLabel(d.label); });
      var best = L.pickCamera(cams, null);
      sel.textContent = "";
      sel.appendChild(opt("", named.length && best.id ? "Automatic — " + L.shortCam(best.label, 40) : "Automatic"));
      var chosen = "";
      named.forEach(function (d) {
        var k = L.cameraKind(d.label), tag = k === "virtual" ? " (phone / virtual)" : k === "ir" ? " (infrared)" : "";
        labels[d.deviceId] = d.label;
        sel.appendChild(opt(d.deviceId, L.camLabel(d.label) + tag));
      });
      if (c) {
        var p = L.pickCamera(cams, c);
        if (p.how === "chosen" || p.how === "chosen-label") chosen = p.id;
        else { chosen = "chosen:missing"; sel.appendChild(opt(chosen, (L.camLabel(c.label) || "The camera you chose") + (named.length ? " — not connected" : ""))); }
      }
      sel.value = chosen;
      if (hint) hint.hidden = !!named.length || !MD || (asked && !cams.length);
      if (asked && MD && !cams.length) say("No camera found on this computer.");
      if (!named.length && camOn && !asked) allowOnce(true);
      showUsed();
    });
  }
  /** Ask for the camera, only so that its names can be shown, and let go of it at once. */
  function allowOnce(auto) {
    if (!MD || !MD.getUserMedia || asked) return;
    asked = true;
    MD.getUserMedia({ audio: false, video: true }).then(function (st) {
      st.getTracks().forEach(function (t) { t.stop(); });
      list();
    }, function (e) {
      if (!auto) say(APP && !camOn ? "The app lets the camera be used only while Camera presence is on: switch it on in the app's Settings or its tray, then choose here." : "The camera was not allowed, so the names cannot be shown. Automatic still avoids phone and virtual cameras.");
      asked = !!auto; // a click may try again
    });
  }
  if (allowBtn) allowBtn.addEventListener("click", function () { asked = false; allowOnce(false); });
  if (sel) sel.addEventListener("change", function (e) {
    e.stopPropagation();
    var v = sel.value;
    if (v === "chosen:missing") return;
    var o = sel.options[sel.selectedIndex];
    try {
      if (!v) window.localStorage.removeItem(CAMKEY);
      else window.localStorage.setItem(CAMKEY, JSON.stringify({ id: v, label: labels[v] || "" }));
    } catch (x) { say("This browser does not let the page remember it (storage blocked)."); return; }
    say((v ? "Eye contact uses " + L.camLabel(labels[v])  : "Automatic: this computer's own camera") + (camOn ? ". An open Command Center switches to it now." : ". Used once Camera presence is on."));
  });
  if (MD && MD.addEventListener) MD.addEventListener("devicechange", function () { list(); });
  window.addEventListener("storage", function (e) { if (e.key === CAMKEY) list(); else if (e.key === USED) showUsed(); });
  setInterval(showUsed, 3000);

  /* ---------------------------------------------------------------- look and speak: "Show what it sees" (2026-10-21)
   * A checklist of each condition look and speak waits for, live, with its numbers -- so a "it does not start"
   * shows which line stays red. The camera module runs on this page only while the section is open (and eye
   * contact is on); its level meter runs while a face looks at the screen; no turn is started from here. */
  var show = box.querySelector("[data-mp-show]"), checks = box.querySelector("[data-mp-checks]"), showNote = box.querySelector("[data-mp-show-note]");
  var VOICE = box.getAttribute("data-voice-ready") === "1", MPm = window.JoyaPresence, showT = 0;
  function botPos() { var b = null; try { b = JSON.parse(lsGet("joya-presence-bot") || "null"); } catch (e) { b = null; } return b && isFinite(b.x) && isFinite(b.y) ? b : { x: 0.85, y: 0.85 }; }
  function li(ok, label, val) {
    var e = document.createElement("li");
    e.className = ok === true ? "ok" : ok === false ? "no" : "na";
    e.innerHTML = '<span class="mk" aria-hidden="true"></span><b></b><span class="v"></span>';
    e.querySelector(".mk").textContent = ok === true ? "✓" : ok === false ? "✗" : "–";
    e.querySelector("b").textContent = label;
    e.querySelector(".v").textContent = val || "";
    e.setAttribute("aria-label", label + ": " + (ok === true ? "yes" : ok === false ? "no" : "not known") + (val ? ", " + val : ""));
    return e;
  }
  function deg(v) { return v == null ? "–" : (v > 0 ? "+" : "") + Math.round(v) + "°"; }
  function renderLook() {
    if (!checks || !MPm || !MPm.look) return;
    var g = MPm.look(), T = L.TOL;
    var rows = [];
    if (!g.camera) {
      rows.push(li(false, "Camera", g.why === "denied" ? "not allowed" : g.why === "no camera" ? "no camera found" : "opening…"));
    } else {
      rows.push(li(g.face && !g.others, "Face found", !g.face ? "no face" : g.others ? g.others + " other face(s) as close — it stands down" : "you"));
      rows.push(li(g.face ? g.facing : null, "Facing the bot", g.face ? "sideways " + deg(g.dy) + " (within ±" + T.speakYaw + "°), up/down " + deg(g.dp) + " (within +" + T.botUp + "° / −" + T.botDown + "°)" + (g.facing ? ", held " + (Math.min(g.held, g.armMs) / 1000).toFixed(1) + " of " + (g.armMs / 1000).toFixed(1) + " s" : "") : ""));
      // 2026-10-22: the numbers behind "is it you speaking?" -- the lips' movement, the voice, the two together
      rows.push(li(g.mouth == null ? null : g.mouth, "Lips moving", g.lip == null ? "not seen yet" : "score " + g.lip.toFixed(2) + " (needs " + g.lipNeed.toFixed(2) + ")" +
        (g.lipRest != null ? ", your still mouth's jitter " + g.lipRest.toFixed(3) : "") + (g.fps ? " · camera " + g.fps + " fps, " + g.ms + " ms a frame" : "")));
      rows.push(li(g.mic ? g.loud : null, "Voice heard", !g.mic ? "the microphone listens while you look at the screen" : g.voiced == null ? "level " + g.level.toFixed(3) + " vs " + g.need.toFixed(3) + " needed" :
        "voice " + g.vad.toFixed(2) + " (voiced " + g.voiced.toFixed(2) + ", speech-like " + g.speechy.toFixed(2) + ") · level " + g.level.toFixed(3) + " vs " + g.need.toFixed(3) + " needed"));
      rows.push(li(g.mic && g.mouth != null ? g.fused : null, "Lips and voice together", !g.mic ? "" : g.fused ? "yes — a turn starts" : g.sync != null ? "in step " + g.sync.toFixed(2) + " (needs " + g.syncNeed.toFixed(2) + ")" : g.loud && g.mouth === false ? "a voice, but your lips are still" : g.mouth && !g.loud ? "lips move, no voice" : "waiting"));
      rows.push(li(VOICE, "Voice ready", VOICE ? "on" : "voice is off — Settings ▸ Voice"));
      rows.push(li(!g.busy, "Not busy", g.busy ? "a call or a reply is going on" : "nothing else going on"));
      rows.push(li(g.coolLeft <= 0, "Cool-down", g.coolLeft > 0 ? (g.coolLeft / 1000).toFixed(1) + " s left" : "ready"));
    }
    checks.textContent = "";
    rows.forEach(function (r) { checks.appendChild(r); });
    var last = g.turns && g.turns.last;
    if (showNote) showNote.textContent = last && Date.now() - last.t < 6000 ? "✓ All conditions met at " + new Date(last.t).toLocaleTimeString() + (VOICE ? " — in the Command Center this starts listening." : " — but voice is off, so nothing would start.") : "Face JOYA AI's bot and say something.";
  }
  function showOn(on) {
    if (!MPm) { if (showNote) showNote.textContent = "Not available on this page."; return; }
    clearInterval(showT); showT = 0;
    if (on && !camOn) { if (checks) checks.textContent = ""; if (showNote) showNote.textContent = "Switch Camera presence on first" + (APP ? " (in the app's Settings or its tray)." : " (above)."); return; }
    if (on) {
      MPm.hooks({ ready: function () { return VOICE; }, busy: function () { return false; }, speak: function () { return false; } });
      MPm.configure({ prefs: { cam: true, speak: false, saver: false }, host: {}, bot: botPos(), camera: choice(), show: true });
      renderLook();
      showT = setInterval(renderLook, 250);
    } else {
      MPm.configure({ prefs: { cam: false }, show: false });
      if (checks) checks.textContent = "";
    }
  }
  if (show) show.addEventListener("toggle", function () { showOn(show.open); });
  document.addEventListener("visibilitychange", function () { if (show && show.open && !document.hidden) showOn(true); });

  function read() { var v = null; try { v = window.localStorage.getItem(KEY); } catch (e) { v = null; } return L.normPrefs(v); }
  function paint(p, inUse) {
    var was = camOn;
    camOn = !!p.cam;
    if (camOn !== was) list();
    if (camOn !== was && show && show.open) showOn(camOn);
    el("cam").checked = p.cam; el("speak").checked = p.speak; el("saver").checked = p.saver;
    box.classList.toggle("mp-nocam", !p.cam);
    [el("speak"), el("saver")].forEach(function (i) { i.disabled = !p.cam || APP; i.closest(".row").classList.add("mp-needcam"); });
    if (stateEl) {
      stateEl.textContent = !p.cam ? "Off" : inUse ? "On — the camera is in use now" : "On — the camera opens while the Command Center is up";
      stateEl.classList.toggle("on", !!p.cam);
    }
  }

  list();
  if (!APP) {
    paint(read(), false);
    box.addEventListener("change", function (e) {
      var k = e.target.getAttribute("data-mp");
      if (!k) return;
      var p = read();
      p[k] = e.target.checked;
      if (k === "cam" && !p.cam) p.speak = false;
      p = L.normPrefs(p);
      try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (x) { say("This browser does not let the page remember it (storage blocked)."); }
      paint(p, false);
      say(p.cam ? "On for this browser. Open the Command Center: the browser asks you once for the camera." : k === "cam" ? "Off. The camera is let go of at once." : "Saved for this browser.");
    });
    window.addEventListener("storage", function (e) { if (e.key === KEY) paint(read(), false); });
    return;
  }

  // The app: shown, not switched on from here.
  function fromApp(v) {
    if (!v) return;
    var p = L.normPrefs({ cam: !!v.camera, speak: !!v.speak, saver: v.releaseOnSaver !== false });
    paint(p, !!v.inUse);
    el("cam").disabled = !p.cam; // only OFF from here
    if (offBtn) offBtn.hidden = !p.cam;
  }
  function load() { T.core.invoke("get_state").then(function (s) { fromApp(s && s.presence); }, function () { say("The app's setting could not be read."); }); }
  load();
  if (T.event && T.event.listen) T.event.listen("joya://state", function (e) { fromApp(e.payload && e.payload.presence); });
  function off() { T.core.invoke("presence_off").then(function () { say("Off. The app let go of the camera."); load(); }, function () { say("Not switched off — use the tray's “Camera presence”."); }); }
  box.addEventListener("change", function (e) { if (e.target.getAttribute("data-mp") === "cam" && !e.target.checked) off(); });
  if (offBtn) offBtn.addEventListener("click", off);
})();
