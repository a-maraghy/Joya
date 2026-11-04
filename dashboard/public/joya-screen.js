"use strict";
/*
 * Settings > Screen control: the page map's tree (fold and filter) and Rescan
 * pages (the scan runs on the server; its steps play here as a short progress
 * bar, then the page reloads with the diff). Without JavaScript the tree is
 * all open and Rescan is a plain form post.
 */
(function () {
  var tree = document.getElementById("reg-tree");
  if (tree) {
    tree.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tw]");
      if (!b) return;
      var li = b.closest("li");
      if (li) li.classList.toggle("open");
    });
    var q = document.querySelector("[data-reg-q]");
    if (q) {
      q.addEventListener("input", function () {
        var t = q.value.trim().toLowerCase();
        var items = tree.querySelectorAll("li");
        for (var i = 0; i < items.length; i++) {
          var li = items[i];
          var hit = !t || (li.getAttribute("data-tn") || "").indexOf(t) >= 0 || li.querySelector('li[data-tn*="' + t.replace(/["\\]/g, "") + '"]');
          li.hidden = !hit;
          li.classList.toggle("open", !!t && !!hit && !!li.querySelector("ul"));
        }
      });
    }
  }

  var form = document.querySelector("form[data-rescan]");
  if (!form) return;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = form.querySelector("button");
    if (btn) btn.disabled = true;
    var live = document.getElementById("scan-live"), bar = document.getElementById("scan-bar"), log = document.getElementById("scan-log");
    if (live) live.hidden = false;
    fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "fetch", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var steps = (d && d.steps) || [];
        var i = 0;
        var t = setInterval(function () {
          if (bar) bar.style.width = Math.min(100, ((i + 1) / Math.max(1, steps.length)) * 100) + "%";
          if (log) log.textContent = steps[i] || "";
          i++;
          if (i > steps.length) {
            clearInterval(t);
            var slot = document.getElementById("flash");
            if (slot && d.flash) slot.innerHTML = d.flash;
            if (d.reload) window.location.reload();
          }
        }, 260);
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (log) log.textContent = "The scan did not answer. Try again.";
      });
  });
})();
