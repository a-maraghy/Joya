"use strict";
/*
 * The frame, and the OS / Agents pages that move.
 *
 * Everything here is progressive: each block looks for its own markup and does
 * nothing if the page has none, and every page is complete without it. No
 * inline handlers (the CSP forbids them) -- listeners are attached from here.
 *
 *   sidebar collapse   remembered per browser under "joya-side"
 *   sidebar groups     each label folds its group ("joya-side-shut")
 *   avatar menu        account, devices, appearance, theme, sign out
 *   needs you          the top bar's Decisions pill, from "joya-needs" events
 *   live forms         settings rows saved in place ([data-live])
 *   clock              the browser's own time and zone, in the top bar
 *   (machine core      the OS overview's mycelium lives in mycelium.js)
 *   vitals             CPU / RAM / disk rings, refreshed from /api/stats
 *   contents           the "on this page" list of a document page
 *   journal tail       an agent's last journal lines, refreshed in place
 */

(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var TAU = Math.PI * 2;
  var GOLDEN = Math.PI * (3 - Math.sqrt(5));

  function store(key, value) {
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) {
      /* storage blocked: the choice lasts until the page is left */
    }
  }

  /* ------------------------------------------------------ sidebar collapse */
  (function () {
    var btn = document.querySelector("[data-side-collapse]");
    if (!btn) return;
    function sync() {
      var c = root.getAttribute("data-side") === "collapsed";
      btn.setAttribute("aria-expanded", c ? "false" : "true");
      btn.title = c ? "Expand the sidebar" : "Collapse the sidebar to icons";
      var label = btn.querySelector("span");
      if (label) label.textContent = c ? "Expand" : "Collapse to icons";
    }
    btn.addEventListener("click", function () {
      var c = root.getAttribute("data-side") !== "collapsed";
      if (c) root.setAttribute("data-side", "collapsed");
      else root.removeAttribute("data-side");
      store("joya-side", c ? "collapsed" : null);
      sync();
      window.dispatchEvent(new Event("resize"));
    });
    sync();
  })();

  /* ------------------------------------------------ sidebar group labels */
  // Each group label folds its group; which ones are folded is remembered per
  // browser under "joya-side-shut". The collapsed icon rail shows every group.
  (function () {
    var labels = document.querySelectorAll("[data-side-group]");
    if (!labels.length) return;
    var KEY = "joya-side-shut";
    var shut = [];
    try { shut = JSON.parse(window.localStorage.getItem(KEY) || "[]") || []; } catch (e) { shut = []; }
    function paint() {
      for (var i = 0; i < labels.length; i++) {
        var k = labels[i].getAttribute("data-side-group");
        var off = shut.indexOf(k) >= 0 && !labels[i].parentNode.querySelector(".side-item.on");
        labels[i].parentNode.classList.toggle("shut", off);
        labels[i].setAttribute("aria-expanded", off ? "false" : "true");
      }
    }
    for (var i = 0; i < labels.length; i++) {
      labels[i].addEventListener("click", function () {
        var k = this.getAttribute("data-side-group");
        var at = shut.indexOf(k);
        if (at >= 0) shut.splice(at, 1);
        else shut.push(k);
        store(KEY, shut.length ? JSON.stringify(shut) : null);
        paint();
      });
    }
    paint();
  })();

  /* ------------------------------------------------------------ avatar menu */
  // Account, devices, appearance, the theme and sign out, under the avatar.
  (function () {
    var btn = document.getElementById("avatar-btn");
    var menu = document.getElementById("me-menu");
    if (!btn || !menu) return;
    function open(on) {
      menu.hidden = !on;
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      if (on) {
        var first = menu.querySelector("a, button");
        if (first) first.focus();
      }
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      open(menu.hidden);
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !document.querySelector(".cc-sdlg-back")) open(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        open(false);
        btn.focus();
      }
    });
    // Sign out asks first (app.js); the menu steps aside for the dialog.
    menu.addEventListener("submit", function () { open(false); }, true);
  })();

  /* ------------------------------------------------ needs you (top bar) */
  // The dock (joya-dock.js) and the Command Center announce how many Decisions
  // wait; the top bar's pill and the Command Center's sidebar badge follow.
  document.addEventListener("joya-needs", function (e) {
    var n = Math.max(0, Number(e.detail && e.detail.n) || 0);
    var pill = document.getElementById("tb-need");
    if (pill) {
      pill.hidden = !n;
      var c = document.getElementById("tb-need-n");
      if (c) c.textContent = String(n);
      var l = pill.querySelector(".long");
      if (l) l.innerHTML = "&nbsp;" + (n === 1 ? "needs" : "need") + " you";
    }
    var item = document.querySelector('.side-item[href="/joya-ai"]');
    if (item) {
      var b = item.querySelector(".badge");
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement("span"); item.appendChild(b); }
      b.className = "badge warn";
      b.setAttribute("data-badge", "joya-ai");
      b.title = n + (n === 1 ? " needs you" : " need you");
      b.textContent = String(n);
    }
  });

  /* ------------------------------------------------------ bars by data */
  // Sizes that depend on data (a token cap's bar, its warning line) come as
  // data-w / data-l: the CSP refuses style attributes, not element.style.
  (function () {
    var pct = function (v) { var n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; };
    var w = document.querySelectorAll(".ubar [data-w]");
    for (var i = 0; i < w.length; i++) w[i].style.width = pct(w[i].getAttribute("data-w")) + "%";
    var l = document.querySelectorAll(".ubar [data-l]");
    for (var j = 0; j < l.length; j++) l[j].style.left = pct(l[j].getAttribute("data-l")) + "%";
  })();

  /* ------------------------------------------------------------ live forms */
  // A settings row is a small form ([data-live]): sent as soon as one of its
  // controls changes (a number field when it is committed: Enter or leaving
  // it), in place, with the server's note shown in the page's flash slot.
  // A form that asks first (data-confirm-dlg) asks through the OS confirm.
  // Without JavaScript the same form posts and the page comes back with the note.
  (function () {
    var busy = false;
    function note(html) {
      var slot = document.getElementById("flash");
      if (!slot) return;
      slot.innerHTML = html || "";
      var main = document.querySelector("main.content");
      var r = slot.getBoundingClientRect();
      if (main && (r.top < 60 || r.top > window.innerHeight)) main.scrollTo({ top: 0, behavior: "smooth" });
    }
    function send(f, revert) {
      if (busy) return;
      var go = function () {
        busy = true;
        f.classList.add("saving");
        fetch(f.action, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "X-Requested-With": "fetch", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(new FormData(f)).toString(),
        })
          .then(function (r) { return r.json().catch(function () { return { ok: false, flash: "" }; }); })
          .then(function (d) {
            note(d.flash);
            if (!d.ok && revert) revert();
            if (d.reload) window.location.reload();
          })
          .catch(function () {
            if (revert) revert();
            note('<div class="alert bad"><div>Not saved: the panel did not answer. Try again.</div></div>');
          })
          .then(function () {
            busy = false;
            f.classList.remove("saving");
          });
      };
      var q = f.getAttribute("data-confirm-dlg");
      if (!q || !window.JoyaUI) return go();
      window.JoyaUI.confirm({ title: q, body: f.getAttribute("data-confirm-body") || "", yes: f.getAttribute("data-confirm-yes") || "Confirm", danger: f.getAttribute("data-confirm-danger") !== "0" }).then(function (ok) {
        if (ok) go();
        else if (revert) revert();
      });
    }
    document.addEventListener("change", function (e) {
      var el = e.target;
      // A control may sit outside its form (form="id", as in the token caps table).
      var f = el && el.form && el.form.hasAttribute("data-live") ? el.form : el && el.closest && el.closest("form[data-live]");
      if (!f || el.hasAttribute("data-no-live")) return;
      var revert = null;
      if (el.type === "checkbox") { var was = !el.checked; revert = function () { el.checked = was; }; }
      send(f, revert);
    });
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (!(f instanceof HTMLFormElement) || !f.hasAttribute("data-live")) return;
      e.preventDefault();
      send(f, null);
    });
    // A button in a live form that is not its submit (Resume, Rescan...) is sent by os.js too.
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("form[data-live] button[type=submit][name]");
      if (!b) return;
      e.preventDefault();
      var f = b.form;
      var h = f.querySelector('input[type=hidden][data-btn]');
      if (!h) { h = document.createElement("input"); h.type = "hidden"; h.setAttribute("data-btn", ""); f.appendChild(h); }
      h.name = b.name;
      h.value = b.value;
      send(f, null);
    });
  })();

  /* ----------------------------------------------------------------- clock */
  // The administrator's zone (data-tz), the same the Command Center keeps.
  (function () {
    var el = document.querySelector("[data-clock]");
    if (!el) return;
    var b = el.querySelector("b");
    var s = el.querySelector("span");
    var zone = el.getAttribute("data-tz") || undefined;
    var city = (zone || "").split("/").pop().replace(/_/g, " ");
    var fHMS, fDate;
    try {
      fHMS = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      fDate = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" });
    } catch (e) {
      fHMS = null;
    }
    function tick() {
      var d = new Date();
      if (fHMS) {
        b.textContent = fHMS.format(d);
        s.textContent = fDate.format(d) + (city ? " · " + city : "");
      } else {
        b.textContent = d.toTimeString().slice(0, 8);
      }
    }
    tick();
    setInterval(tick, 1000);
  })();

  /* ---------------------------------------------------------- contents --- */
  // A document page's "on this page" list: highlights the section in view and
  // scrolls to one smoothly (unless motion is reduced).
  (function () {
    var toc = document.querySelector("[data-toc]");
    if (!toc) return;
    var scroller = document.querySelector(".content.pat-c") || window;
    var links = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    function update() {
      var best = null;
      links.forEach(function (a) {
        var sec = document.getElementById(a.getAttribute("href").slice(1));
        if (sec && sec.getBoundingClientRect().top < 200) best = a;
      });
      links.forEach(function (a) { a.classList.toggle("on", a === (best || links[0])); });
    }
    (scroller === window ? window : scroller).addEventListener("scroll", update, { passive: true });
    toc.addEventListener("click", function (e) {
      var a = e.target.closest("a[href^='#']");
      if (!a) return;
      var sec = document.getElementById(a.getAttribute("href").slice(1));
      if (!sec) return;
      e.preventDefault();
      sec.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", a.getAttribute("href"));
    });
    update();
  })();

  /* ---------------------------------------------------- vitals rings ----- */
  function setRing(cell, pct, sub) {
    if (!cell) return;
    var val = cell.querySelector(".val");
    var b = cell.querySelector("b");
    var small = cell.querySelector("small");
    var c = 2 * Math.PI * 24;
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (val) {
      val.setAttribute("stroke-dasharray", (c * pct / 100).toFixed(1) + " " + c.toFixed(1));
      val.setAttribute("class", "val" + (pct > 90 ? " bad" : pct > 75 ? " hot" : ""));
    }
    if (b) b.textContent = pct + "%";
    if (small && sub) small.textContent = sub;
  }
  function gb(n) { return n == null ? "—" : (n / Math.pow(1024, 3)).toFixed(n >= 10 * Math.pow(1024, 3) ? 0 : 1); }

  /* ------------------------------------------------ live vitals (OS) ----- */
  (function () {
    var box = document.querySelector("[data-vitals]");
    if (!box) return;
    function refresh() {
      if (document.hidden) return;
      fetch("/api/stats", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("stats"); return r.json(); })
        .then(function (d) {
          var s = d.stats;
          var cpu = Math.min(100, (s.loadavg[0] / Math.max(1, s.cpus)) * 100);
          var ram = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0;
          var disk = s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : 0;
          setRing(box.querySelector('[data-ring="cpu"]'), cpu);
          setRing(box.querySelector('[data-ring="ram"]'), ram, gb(s.memUsed) + " / " + gb(s.memTotal) + " GB");
          setRing(box.querySelector('[data-ring="disk"]'), disk, gb(s.diskUsed) + " / " + gb(s.diskTotal) + " GB");
          var load = document.querySelector("[data-load]");
          if (load) load.textContent = s.loadavg.map(function (n) { return n.toFixed(2); }).join(" · ");
        })
        .catch(function () { /* keep the last values */ });
    }
    setInterval(refresh, 15000);
  })();

  /* ----------------------------------------------------- memory dial ----- */
  // The agent's memory as a dial: one dot per note on the golden angle, the
  // newest darkest (ink). Drawn once as SVG from the count the server
  // put on the element.
  (function () {
    var svg = document.querySelector("svg[data-vault]");
    if (!svg) return;
    var n = Math.max(0, Math.min(900, parseInt(svg.getAttribute("data-vault"), 10) || 0));
    var NS = "http://www.w3.org/2000/svg";
    function el(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      svg.appendChild(e);
      return e;
    }
    el("circle", { r: 156, fill: "none", class: "v-ring" });
    el("circle", { r: 118, fill: "none", class: "v-ring dashed" });
    var s = 7;
    function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    // The dots fill the ring between the hole and the rim whatever the count:
    // five notes and five hundred both read as a dial, not a speck.
    var big = n < 40 ? 2.2 : n < 150 ? 1.2 : 0.4;
    // spokes from the centre to the newest notes: what was written last
    for (var j = Math.max(1, n - 7); j <= n; j++) {
      var rj = 50 + 96 * Math.sqrt(j / n), tj = j * GOLDEN;
      el("line", { x1: (44 * Math.cos(tj)).toFixed(1), y1: (44 * Math.sin(tj)).toFixed(1), x2: (rj * Math.cos(tj)).toFixed(1), y2: (rj * Math.sin(tj)).toFixed(1), class: "v-spoke" });
    }
    for (var k = 1; k <= n; k++) {
      var rr = 50 + 96 * Math.sqrt(k / n), th = k * GOLDEN, age = k / n, sz = 1.6 + big + rnd() * 2.6, fresh = k > n - 8;
      el("circle", {
        cx: (rr * Math.cos(th)).toFixed(1), cy: (rr * Math.sin(th)).toFixed(1), r: sz.toFixed(1),
        class: fresh ? "v-fl hi" : age > 0.6 ? "v-fl mid" : "v-fl",
        opacity: (fresh ? 1 : 0.45 + 0.5 * (1 - age)).toFixed(2),
      });
    }
    for (k = 0; k < 72; k++) {
      var a = (k / 72) * TAU, L = k % 6 ? 4 : 9;
      el("line", { x1: (156 * Math.cos(a)).toFixed(1), y1: (156 * Math.sin(a)).toFixed(1), x2: ((156 - L) * Math.cos(a)).toFixed(1), y2: ((156 - L) * Math.sin(a)).toFixed(1), class: "v-tick" });
    }
    var frac = Math.max(0.04, Math.min(1, n / 400));
    var a0 = -Math.PI / 2, a1 = a0 + frac * TAU * 0.999;
    el("path", {
      d: "M" + (150 * Math.cos(a0)).toFixed(1) + " " + (150 * Math.sin(a0)).toFixed(1) + " A150 150 0 " + (a1 - a0 > Math.PI ? 1 : 0) + " 1 " + (150 * Math.cos(a1)).toFixed(1) + " " + (150 * Math.sin(a1)).toFixed(1),
      class: "v-arc", fill: "none",
    });
    el("circle", { r: 42, class: "v-hole" });
  })();

  /* ---------------------------------------------------- journal tail ----- */
  (function () {
    var box = document.querySelector("[data-journal]");
    if (!box) return;
    var url = box.getAttribute("data-journal");
    var pre = box.querySelector("pre");
    var busy = false;
    function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("logs"); return r.json(); })
        .then(function (d) {
          if (typeof d.html !== "string") return;
          var atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
          pre.innerHTML = d.html; // rendered and escaped by the server's own view code
          if (atEnd) box.scrollTop = box.scrollHeight;
        })
        .catch(function () { /* keep what is on screen */ })
        .then(function () { busy = false; });
    }
    box.scrollTop = box.scrollHeight;
    setInterval(refresh, 10000);
    var btn = document.querySelector("[data-journal-refresh]");
    if (btn) btn.addEventListener("click", function (e) { e.preventDefault(); refresh(); });
  })();

  /* ------------------------------------------------ logs start at the end */
  Array.prototype.forEach.call(document.querySelectorAll("[data-scroll-end]"), function (el) {
    el.scrollTop = el.scrollHeight;
  });
})();
