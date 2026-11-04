"use strict";
/*
 * The browser half of the desktop app's sign-in hand-off (lib/desktop.js):
 * after Link, send this tab back to the app's loopback address with the
 * one-time code. The address comes from the page (data-to, written by the
 * server, always http://127.0.0.1:<port>/joya-callback?code=...); a link with
 * the same address is there if this does not run.
 */
(function () {
  var el = document.getElementById("dk-linked");
  if (!el) return;
  var to = el.getAttribute("data-to") || "";
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/joya-callback\?code=[A-Za-z0-9_-]{43}$/.test(to)) return;
  setTimeout(function () { window.location.replace(to); }, 300);
})();
