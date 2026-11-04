"use strict";
/*
 * The app's start card (dist/index.html). It asks the app for the site's address, checks the
 * site answers (GET /desktop/ping: a no-cors probe, which the site marks
 * Cross-Origin-Resource-Policy: cross-origin for exactly this), and then asks the APP to open
 * the Command Center (go_site): a navigation started by this page would be cross-site, and the
 * site's SameSite=Strict session cookie would stay behind (see go_site in src-tauri/src/lib.rs).
 *
 * It never sits silently on "Connecting": offline it counts down and retries (5 s up to 60 s);
 * if the site answered but the Command Center did not open within OPEN_MS, or the app brought
 * the window back here (?stuck=1, its 25 s watchdog), it says so, with Retry and "Open in your
 * browser". Only the card catches the mouse.
 */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T && T.core ? T.core.invoke(c, a || {}) : Promise.reject(new Error("no app bridge")); };
  var $ = function (id) { return document.getElementById(id); };
  var OPEN_MS = 20000;
  var wait = 5, left = 0, timer = 0, openT = 0, origin = "https://joya.example.com";
  var q = location.search;

  function host() { return origin.replace(/^https:\/\//, ""); }
  function regions() {
    var r = $("gate").getBoundingClientRect();
    invoke("set_hit_regions", { regions: [{ x: r.left, y: r.top, w: r.width, h: r.height, r: 14 }], dpr: window.devicePixelRatio || 1 }).catch(function () {});
  }
  function place(st) {
    var g = $("gate"), W = innerWidth, H = innerHeight;
    var x = W / 2, y = st && st.mode === "floating" ? H - 140 : H * 0.42;
    g.style.left = Math.round(x - g.offsetWidth / 2) + "px";
    g.style.top = Math.round(Math.max(8, Math.min(H - g.offsetHeight - 8, y - g.offsetHeight / 2))) + "px";
    document.documentElement.setAttribute("data-ink", st && st.ink === "dark" ? "dark" : "light");
    regions();
  }
  function say(title, sub, retry, browser) {
    $("g-title").textContent = title;
    $("g-sub").textContent = sub;
    $("g-retry").hidden = !retry;
    $("g-browser").hidden = !browser;
    invoke("get_state").then(place, function () { regions(); });
  }
  function stuck(why) {
    clearInterval(timer);
    clearTimeout(openT);
    say("The Command Center did not open", why + " Retry, or open it in your browser; JOYA AI keeps trying when you retry.", true, true);
  }
  function go() {
    clearInterval(timer);
    clearTimeout(openT);
    say("Connecting to JOYA AI…", host(), false, false);
    fetch(origin + "/desktop/ping", { mode: "no-cors", cache: "no-store" }).then(function () {
      say("Opening the Command Center…", host(), false, false);
      openT = setTimeout(function () { stuck(host() + " answered, but its page did not open in " + OPEN_MS / 1000 + " s."); }, OPEN_MS);
      return invoke("go_site").then(function (ok) { if (!ok) stuck("The app could not open " + host() + "."); });
    }).catch(function (e) {
      if (e && /bridge/.test(e.message || "")) return stuck("This page is not running inside the JOYA AI app.");
      left = wait;
      wait = Math.min(60, wait * 2);
      tick();
      timer = setInterval(tick, 1000);
    });
  }
  function tick() {
    if (left <= 0) return go();
    say("Offline", "Can't reach " + host() + ". Retrying in " + left + " s — nothing typed is sent while offline.", true, false);
    left--;
  }
  $("g-retry").addEventListener("click", function () { wait = 5; go(); });
  $("g-browser").addEventListener("click", function () { invoke("open_full_cc").catch(function () {}); });
  addEventListener("resize", function () { invoke("get_state").then(place, function () {}); });
  invoke("settings_get").then(function (v) {
    if (v && v.settings && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(v.settings.origin)) origin = v.settings.origin.replace(/\/$/, "");
  }, function () {}).then(function () {
    if (/[?&]stuck=1/.test(q)) stuck("The page from " + host() + " did not finish loading in 25 s.");
    else if (/[?&]offline=1/.test(q)) { left = 5; tick(); timer = setInterval(tick, 1000); }
    else go();
  });
  if (T && T.event) T.event.listen("joya://state", function (e) { place(e.payload); });
})();
