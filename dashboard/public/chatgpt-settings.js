/*
 * JOYA AI Settings > ChatGPT, the page's half (lib/routes-chatgpt.js).
 *
 * - While a sign-in waits for the person (#gpt-login), ask the server every
 *   few seconds how it is going, say so in the live region, and reload once
 *   it is done (or say why it is not).
 * - Times are written in Cairo time by the server; show them in the
 *   browser's own time instead.
 *
 * No inline script or style (the CSP). Without JavaScript the page still
 * works: the code is on the page, and a reload shows the new state.
 */
(function () {
  "use strict";

  function localTimes() {
    var els = document.querySelectorAll("time[data-local]");
    for (var i = 0; i < els.length; i++) {
      var d = new Date(els[i].getAttribute("datetime"));
      if (isNaN(d.getTime())) continue;
      els[i].textContent = els[i].hasAttribute("data-time-only")
        ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }
  }

  function poll() {
    var box = document.getElementById("gpt-login");
    if (!box) return;
    var say = document.getElementById("gpt-login-state");
    var stopped = false;
    function tick() {
      if (stopped) return;
      fetch("/joya-ai/settings/chatgpt/login/state", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.state === "pending") return void setTimeout(tick, 4000);
          stopped = true;
          if (j.state === "done" || j.state === "none") {
            say.textContent = "Signed in. Updating the page…";
            return void setTimeout(function () { window.location.reload(); }, 800);
          }
          box.classList.add("ended");
          say.textContent = (j.state === "expired" ? "The code expired. " : "The sign-in did not finish. ") + (j.message || "") + " Start again with Sign in again.";
          var again = document.createElement("a");
          again.href = "/joya-ai/settings/chatgpt";
          again.className = "btn small";
          again.textContent = "Back to ChatGPT settings";
          say.parentNode.appendChild(again);
        })
        .catch(function () { setTimeout(tick, 8000); });
    }
    setTimeout(tick, 3000);
  }

  /* "Copy code": shown only where the clipboard works; says so for screen readers too. */
  function copyButton() {
    var b = document.getElementById("gpt-copy");
    if (!b || !navigator.clipboard || !window.isSecureContext) return;
    b.hidden = false;
    b.addEventListener("click", function () {
      navigator.clipboard.writeText(b.getAttribute("data-copy") || "").then(function () {
        b.textContent = "Copied";
        setTimeout(function () { b.textContent = "Copy code"; }, 2000);
      }, function () { b.textContent = "Copy failed"; });
    });
  }

  function start() {
    localTimes();
    copyButton();
    poll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
