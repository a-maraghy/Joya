/*
 * JOYA AI desktop app, the sign-in pages and the Command Center (where every
 * approval asks for Windows Hello, public/step-up.js): Windows Hello inside
 * the app.
 *
 * The app's window is click-through, borderless, often bottom-most (Desktop
 * layer) and does not take the focus by itself -- and Windows Hello's dialog
 * belongs to the window that asks for it. So for as long as a passkey
 * ceremony runs (navigator.credentials.get / create), the app is told
 * (`webauthn_ceremony`) and makes the window an ordinary one: clicks reach it,
 * it is on top and it has the focus. When the ceremony ends -- done, refused
 * or failed -- the window goes back to its mode.
 *
 * If it fails anyway (a refusal, a timeout, Hello not showing), the browser
 * sign-in button is lit up as the way through on the sign-in pages; in the
 * Command Center the approval dialog offers the authenticator code instead.
 *
 * Loaded before passkey.js; does nothing outside the app.
 */
(function () {
  "use strict";
  var T = window.__TAURI__;
  var C = navigator.credentials;
  if (!T || !T.core || !T.core.invoke || !C) return;
  function tell(on) {
    try { return T.core.invoke("webauthn_ceremony", { on: on }).catch(function () {}); } catch (e) { return Promise.resolve(); }
  }
  function failed(e) {
    if (e && e.name === "AbortError") return; // the page cancelled it itself (switching to the code, a new attempt)
    var b = document.getElementById("dk-browser-signin");
    if (!b) return;
    b.classList.add("dk-urge");
    var n = document.getElementById("dk-browser-note");
    if (n) n.textContent = "Windows Hello did not finish inside the app. Your browser can do it: the app is signed in when you are.";
  }
  function wrap(name) {
    var orig = C[name] && C[name].bind(C);
    if (!orig) return;
    try {
      C[name] = function (opts) {
        if (!opts || !opts.publicKey) return orig(opts); // not a passkey (a password credential): as it was
        var ready = tell(true);
        return ready
          .then(function () { return orig(opts); })
          .then(
            function (r) { tell(false); return r; },
            function (e) { tell(false); failed(e); throw e; }
          );
      };
    } catch (e) { /* a read-only credentials object: Hello still works, without the help */ }
  }
  wrap("get");
  wrap("create");
})();
