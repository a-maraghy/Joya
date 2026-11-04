/**
 * Passkeys (Windows Hello) in the browser: the sign-in form, the second step,
 * and Account ▸ Passkeys. The WebAuthn calls are @simplewebauthn/browser's
 * (public/simplewebauthn-browser.js, self-hosted: the CSP allows no CDN).
 *
 *  /login         a "Sign in with a passkey" switch. On a browser that has
 *                 signed in with a passkey here before (localStorage, this
 *                 origin only) the form starts in that mode: the code field
 *                 hides and the form sends second=passkey.
 *  /login/verify  starts Windows Hello at once; "Use authenticator code
 *                 instead" shows the code form.
 *  /account       "Add this device (Windows Hello)".
 */
(function () {
  "use strict";
  var W = window.SimpleWebAuthnBrowser;
  var FLAG = "joya.passkey";
  var supported = !!(W && W.browserSupportsWebAuthn && W.browserSupportsWebAuthn());

  function flag(v) {
    try {
      if (v === undefined) return localStorage.getItem(FLAG) === "1";
      if (v) localStorage.setItem(FLAG, "1");
      else localStorage.removeItem(FLAG);
    } catch (e) {
      /* private window or blocked storage: the switch still works by hand */
    }
    return false;
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return { error: r.status === 429 ? "Too many attempts. Try again later." : "The panel did not answer (" + r.status + ")." };
        })
        .then(function (j) {
          j.status = r.status;
          return j;
        });
    });
  }

  /** What a WebAuthn error means to the person at the keyboard. */
  function why(e, adding) {
    var n = e && e.name;
    if (n === "NotAllowedError" || n === "AbortError")
      return "Windows Hello was cancelled or timed out" + (adding ? "." : ", or this device has no passkey for this address.");
    if (n === "InvalidStateError") return "This device already has a passkey for your account here.";
    if (n === "SecurityError") return "This address cannot use passkeys.";
    if (n === "NotSupportedError") return "This browser or device cannot make a passkey.";
    return (e && e.message) || "Something went wrong.";
  }

  /* ------------------------------------------------------- step one ----- */
  var form = document.getElementById("login-form");
  if (form && supported) {
    var second = form.querySelector('input[name="second"]');
    var codeLabel = form.querySelector(".lg-code");
    var code = form.querySelector('input[name="token"]');
    var note = form.querySelector(".lg-pk-note");
    var sw = form.querySelector(".lg-switch");
    var toPk = form.querySelector('[data-pk-mode="passkey"]');
    var toCode = form.querySelector('[data-pk-mode="code"]');
    var setMode = function (pk) {
      second.value = pk ? "passkey" : "";
      codeLabel.hidden = pk;
      code.required = !pk;
      if (pk) code.value = "";
      note.hidden = !pk;
      toPk.hidden = pk;
      toCode.hidden = !pk;
    };
    sw.hidden = false;
    toPk.addEventListener("click", function () {
      setMode(true);
    });
    toCode.addEventListener("click", function () {
      setMode(false);
      code.focus();
    });
    setMode(flag());
  }

  /* ------------------------------------------------------- step two ----- */
  var box = document.getElementById("lg-pk");
  if (box) {
    var csrf = box.getAttribute("data-csrf");
    var go = document.getElementById("lg-pk-go");
    var status = box.querySelector(".lg-pk-status");
    var err = document.querySelector(".lg-err");
    var codeForm = document.querySelector(".lg-code-form");
    var showCode = document.getElementById("lg-code-show");
    var busy = false;
    var say = function (m) {
      if (!m) return void (err.hidden = true);
      err.querySelector("div").textContent = m;
      err.hidden = false;
    };
    showCode.addEventListener("click", function () {
      codeForm.hidden = false;
      showCode.parentNode.hidden = true;
      codeForm.querySelector("input[name=token]").focus();
    });
    var run = function () {
      if (busy) return;
      if (!supported) {
        say("This browser cannot use passkeys. Use your authenticator code.");
        return showCode.click();
      }
      busy = true;
      go.disabled = true;
      say(null);
      status.textContent = "Waiting for Windows Hello…";
      post("/login/passkey/options", { _csrf: csrf })
        .then(function (o) {
          if (!o.options) throw Object.assign(new Error(o.error || "Start again."), { server: o });
          return W.startAuthentication({ optionsJSON: o.options });
        })
        .then(function (response) {
          status.textContent = "Checking…";
          return post("/login/passkey", { _csrf: csrf, response: response });
        })
        .then(function (r) {
          if (r.ok && r.redirect) {
            flag(true);
            status.textContent = "Signed in.";
            return void location.assign(r.redirect);
          }
          throw Object.assign(new Error(r.error || "Invalid credentials."), { server: r });
        })
        .catch(function (e) {
          busy = false;
          go.disabled = false;
          status.textContent = "Face, fingerprint or PIN on this device.";
          if (e && e.server && e.server.restart) {
            say((e.message || "Invalid credentials.") + " Start again.");
            go.disabled = true;
            return;
          }
          say(e && e.server ? e.message : why(e, false));
          var t = go.querySelector("span");
          if (t) t.textContent = "Try Windows Hello again";
        });
    };
    go.addEventListener("click", run);
    // Straight away: this page exists to show the prompt.
    run();
  }

  /* --------------------------------------------------------- account ---- */
  var add = document.getElementById("pk-add");
  var nojs = document.querySelector("[data-pk-nojs]");
  if (add) {
    if (add.getAttribute("data-here") === "0") flag(false); // nothing to sign in with here
    if (!supported) {
      if (nojs) nojs.textContent = "This browser cannot make passkeys. Edge or Chrome on Windows can (Windows Hello).";
    } else {
      if (nojs) nojs.hidden = true;
      add.hidden = false;
      var msg = add.querySelector(".pk-msg");
      var btn = add.querySelector("button[type=submit]");
      var csrfA = add.getAttribute("data-csrf");
      if (W.platformAuthenticatorIsAvailable)
        W.platformAuthenticatorIsAvailable().then(function (ok) {
          if (!ok) msg.textContent = "No Windows Hello on this device; a security key works too.";
        });
      add.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var name = (add.elements.name && add.elements.name.value) || "";
        var codeIn = add.elements.code;
        btn.disabled = true;
        msg.textContent = "Waiting for Windows Hello…";
        post("/account/passkeys/options", { _csrf: csrfA, code: codeIn ? codeIn.value : "" })
          .then(function (o) {
            if (!o.options) throw Object.assign(new Error(o.error || "Not allowed."), { server: o });
            return W.startRegistration({ optionsJSON: o.options });
          })
          .then(function (response) {
            msg.textContent = "Saving…";
            return post("/account/passkeys", { _csrf: csrfA, name: name, response: response });
          })
          .then(function (r) {
            if (!r.ok) throw Object.assign(new Error(r.error || "Not added."), { server: r });
            flag(true);
            location.assign("/account?msg=" + encodeURIComponent(r.msg || "Passkey added.") + "#passkeys");
          })
          .catch(function (e) {
            btn.disabled = false;
            msg.textContent = e && e.server ? e.message : why(e, true);
            if (codeIn && e && e.server && e.server.code) {
              codeIn.value = "";
              codeIn.focus();
            }
          });
      });
    }
  }
})();
