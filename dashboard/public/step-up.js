/*
 * Windows Hello for every approval (2026-10-08), the page's half.
 *
 * The server (lib/stepup.js) refuses an approve that carries no proof with
 * 428 and a challenge bound to that very approve. This file turns that into a
 * small dialog -- "Confirm it is you" -- that starts Windows Hello at once
 * (the platform passkey elsewhere), offers the authenticator code as the
 * fallback, shows how long the card still waits, and sends the same request
 * again with the proof. Nothing here decides anything: without a valid proof
 * the server refuses, whatever this page does.
 *
 *   JoyaStepUp.ask(stepUp, send)  stepUp: the 428's step_up; send(proof) makes
 *                                 the request again and resolves or rejects
 *                                 (a rejection carrying .stepUp is a refused
 *                                 proof: the dialog says why and stays open).
 *   form[data-step-up]            a plain form (Sessions ▸ Live, Settings ▸
 *                                 Usage): asked first, then sent with the proof.
 *
 * Loaded on every page (lib/ui.js). No inline script or style (the CSP).
 * In the desktop app, joya-desktop-webauthn.js makes the window an ordinary
 * one while Windows Hello's dialog is up.
 */
(function () {
  "use strict";
  var PKC = window.PublicKeyCredential;
  var supported = !!(PKC && navigator.credentials && navigator.credentials.get);

  /* ---------------------------------------------------------------- base64url */
  function toBuf(s) {
    var b = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function toB64(buf) {
    var a = new Uint8Array(buf), s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** navigator.credentials.get() with the server's options; resolves to the JSON the server checks. */
  function hello(opts) {
    var pk = {
      challenge: toBuf(opts.challenge),
      rpId: opts.rpId,
      timeout: opts.timeout || 60000,
      userVerification: opts.userVerification || "required",
      allowCredentials: (opts.allowCredentials || []).map(function (c) {
        var o = { type: "public-key", id: toBuf(c.id) };
        if (c.transports && c.transports.length) o.transports = c.transports;
        return o;
      }),
    };
    if (opts.hints) pk.hints = opts.hints;
    return navigator.credentials.get({ publicKey: pk }).then(function (c) {
      if (!c) throw new Error("Windows Hello gave no answer.");
      var r = c.response;
      return {
        id: c.id,
        rawId: toB64(c.rawId),
        type: c.type,
        response: {
          clientDataJSON: toB64(r.clientDataJSON),
          authenticatorData: toB64(r.authenticatorData),
          signature: toB64(r.signature),
          userHandle: r.userHandle && r.userHandle.byteLength ? toB64(r.userHandle) : undefined,
        },
        clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
      };
    });
  }
  function helloWhy(e) {
    var n = e && e.name;
    if (n === "NotAllowedError" || n === "AbortError") return "Windows Hello was cancelled or timed out, or this device has no passkey for your account here.";
    if (n === "SecurityError") return "This address cannot use Windows Hello.";
    if (n === "InvalidStateError" || n === "NotSupportedError") return "This device cannot answer for that passkey.";
    return (e && e.message) || "Windows Hello did not finish.";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var open = null; // one dialog at a time

  /**
   * Ask for Windows Hello (or the code) and send. Resolves to send()'s result;
   * rejects with code "step-up-cancelled" when the person cancels.
   */
  function ask(stepUp, send) {
    if (open) open.cancel();
    return new Promise(function (resolve, reject) {
      var su = stepUp || {};
      var busy = false, done = false, timerId = 0;
      var back = el("div", "cc-sdlg-back joya-su-back");
      var box = el("div", "cc-sdlg joya-su");
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "joya-su-t");
      var h = el("h3", "", "Confirm it is you");
      h.id = "joya-su-t";
      var what = el("p", "joya-su-what");
      var st = el("p", "joya-su-st");
      st.setAttribute("role", "status");
      var tm = el("p", "joya-su-timer");
      tm.hidden = true;
      var err = el("div", "err");
      err.hidden = true;
      var form = el("form", "joya-su-code");
      form.hidden = true;
      form.setAttribute("autocomplete", "off");
      var lab = el("label", "", "Authenticator code");
      var inp = el("input", "cc-in joya-su-in");
      inp.type = "text";
      inp.inputMode = "numeric";
      inp.autocomplete = "one-time-code";
      inp.maxLength = 6;
      inp.pattern = "[0-9]{6}";
      inp.setAttribute("aria-label", "Authenticator code");
      inp.placeholder = "123456";
      // Password-only sign-in (lib/signin.js): the same form asks for the password.
      if (su.password) {
        lab.firstChild.textContent = "Your password";
        inp.type = "password";
        inp.inputMode = "text";
        inp.autocomplete = "current-password";
        inp.removeAttribute("maxLength");
        inp.removeAttribute("pattern");
        inp.setAttribute("aria-label", "Your password");
        inp.placeholder = "";
      }
      var codeGo = el("button", "cc-btn pri", su.password ? "Approve" : "Approve with the code");
      codeGo.type = "submit";
      lab.appendChild(inp);
      form.appendChild(lab);
      form.appendChild(codeGo);
      var acts = el("div", "acts");
      var useCode = el("button", "cc-btn link", "Use authenticator code instead");
      useCode.type = "button";
      var sp = el("span", "sp");
      var cancel = el("button", "cc-btn", "Cancel");
      cancel.type = "button";
      var again = el("button", "cc-btn pri", "Use Windows Hello");
      again.type = "button";
      acts.appendChild(useCode);
      acts.appendChild(sp);
      acts.appendChild(cancel);
      acts.appendChild(again);
      [h, what, st, tm, err, form, acts].forEach(function (x) { box.appendChild(x); });
      back.appendChild(box);
      document.body.appendChild(back); // .cc-sdlg-back: the desktop app makes the whole window clickable while it is up
      var prev = document.activeElement;

      function say(m) { err.textContent = m || ""; err.hidden = !m; }
      function canHello() { return supported && !!(su.passkey && su.token); }
      function paint() {
        what.textContent = su.what || "Approve";
        again.hidden = !canHello();
        useCode.hidden = !su.totp || !form.hidden;
        if (su.password) {
          st.textContent = "Enter your password to approve.";
          showCode();
        } else if (!canHello()) {
          st.textContent = (su.no_passkey || (supported ? "" : "This browser cannot use Windows Hello.")) + (su.totp ? " Enter your authenticator code to approve." : "");
          showCode();
        }
        if (su.code_locked) { inp.disabled = true; codeGo.disabled = true; }
        tick();
      }
      function showCode() {
        if (!su.totp && !su.password) return;
        form.hidden = false;
        useCode.hidden = true;
        setTimeout(function () { try { inp.focus(); } catch (e) { /* gone */ } }, 0);
      }
      function tick() {
        var exp = su.expires_at ? Date.parse(su.expires_at) : NaN;
        if (!isFinite(exp)) { tm.hidden = true; return; }
        var left = Math.max(0, Math.round((exp - Date.now()) / 1000));
        tm.hidden = false;
        tm.textContent = left > 0 ? "The card waits " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " more · then it is denied" : "The card has run out of time: it was denied.";
        tm.classList.toggle("low", left < 20);
      }
      function finish(ok, val) {
        if (done) return;
        done = true;
        clearInterval(timerId);
        back.remove();
        open = null;
        if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
        (ok ? resolve : reject)(val);
      }
      function setBusy(b) {
        busy = b;
        again.disabled = b;
        codeGo.disabled = b || !!su.code_locked;
        useCode.disabled = b;
      }
      function submit(proof, how) {
        setBusy(true);
        say("");
        st.textContent = how === "hello" ? "Windows Hello confirmed. Sending…" : how === "password" ? "Checking…" : "Checking the code…";
        Promise.resolve()
          .then(function () { return send(proof); })
          .then(function (r) { finish(true, r); }, function (e) {
            setBusy(false);
            if (e && e.stepUp) {
              su = e.stepUp;
              say(e.message || "Not accepted.");
              st.textContent = canHello() ? "Try Windows Hello again, or use your authenticator code." : "";
              inp.value = "";
              paint();
              if (how === "totp" || how === "password") showCode();
              return;
            }
            finish(false, e);
          });
      }
      function runHello() {
        if (busy || !canHello()) return;
        setBusy(true);
        say("");
        st.textContent = "Waiting for Windows Hello…";
        var tok = su.token;
        hello(su.passkey).then(function (resp) {
          submit({ token: tok, response: resp }, "hello");
        }, function (e) {
          setBusy(false);
          st.textContent = helloWhy(e) + (su.totp ? " Try again, or use your authenticator code." : "");
          // The challenge is spent only when the server sees it; a cancelled prompt can be tried again with it.
        });
      }
      again.addEventListener("click", runHello);
      useCode.addEventListener("click", showCode);
      cancel.addEventListener("click", function () {
        var e = new Error("Not approved: the confirmation was cancelled.");
        e.code = "step-up-cancelled";
        finish(false, e);
      });
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (su.password) {
          if (!inp.value) return say("Enter your password.");
          if (!busy) submit({ password: String(inp.value) }, "password");
          return;
        }
        var c = String(inp.value || "").replace(/\D/g, "");
        if (c.length !== 6) return say("The code is six digits.");
        if (!busy) submit({ totp: c }, "totp");
      });
      back.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.stopPropagation(); cancel.click(); }
      });
      open = { cancel: function () { cancel.click(); } };
      timerId = setInterval(tick, 1000);
      paint();
      if (canHello()) runHello();
      else if (!su.totp && !su.password) st.textContent = (su.no_passkey || "") + " This account has no authenticator either: it cannot approve here.";
      try { (form.hidden ? again : inp).focus(); } catch (e) { /* fine */ }
    });
  }

  /* ---------------------------------------------------------------- plain forms */
  function formBody(f, extra) {
    var p = new URLSearchParams(new FormData(f));
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }
  function post(f, extra) {
    return fetch(f.action, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "fetch", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(f, extra),
    });
  }
  function textOf(html) {
    try {
      return (new DOMParser().parseFromString(String(html || ""), "text/html").body.textContent || "").trim();
    } catch (e) {
      return "";
    }
  }
  function stepForm(f) {
    post(f, null)
      .then(function (r) {
        var ct = r.headers.get("content-type") || "";
        if (!/json/.test(ct)) return void window.location.assign(r.url); // nothing to approve after all: done as before
        return r.json().then(function (j) {
          if (!j.step_up) {
            if (j.flash) return void window.location.reload();
            throw new Error(j.error || "Not sent.");
          }
          return ask(j.step_up, function (proof) {
            return post(f, { step_up: JSON.stringify(proof) }).then(function (r2) {
              var ct2 = r2.headers.get("content-type") || "";
              if (!/json/.test(ct2)) return void window.location.assign(r2.url);
              return r2.json().then(function (k) {
                if (k.step_up) {
                  var e = new Error(k.error || "Not accepted.");
                  e.stepUp = k.step_up;
                  throw e;
                }
                if (k.ok === false || k.error) throw new Error(k.error || textOf(k.flash) || "Not done.");
                window.location.reload();
              });
            });
          });
        });
      })
      .catch(function (e) {
        if (e && e.code === "step-up-cancelled") return;
        if (window.JoyaUI && window.JoyaUI.confirm) window.JoyaUI.confirm({ title: "Not done", body: (e && e.message) || "The panel did not answer.", yes: "OK", danger: false });
      });
  }
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!(f instanceof HTMLFormElement) || !f.hasAttribute("data-step-up")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var q = f.getAttribute("data-confirm-dlg");
      if (!q || !window.JoyaUI || !window.JoyaUI.confirm) return stepForm(f);
      window.JoyaUI.confirm({
        title: q,
        body: f.getAttribute("data-confirm-body") || "",
        yes: f.getAttribute("data-confirm-yes") || "Confirm",
        no: f.getAttribute("data-confirm-no") || "Cancel",
        danger: f.getAttribute("data-confirm-danger") !== "0",
      }).then(function (ok) {
        if (ok) stepForm(f);
      });
    },
    true
  );

  window.JoyaStepUp = { ask: ask, supported: supported, _hello: hello };
})();
