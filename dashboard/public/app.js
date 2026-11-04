"use strict";
/*
 * Small progressive-enhancement layer.
 *
 * Inline event handlers (onclick=, onsubmit=) are deliberately impossible here:
 * the Content-Security-Policy sets script-src-attr 'none'. So confirmations are
 * wired up from this external file via a delegated listener instead.
 */

/*
 * The OS's dialogs are the Command Center's own (joya-ai.css is on every page):
 *
 *   JoyaUI.confirm({title, body, yes, no, danger}) -> Promise<boolean>
 *       the .cc-sdlg confirm (its retire dialog); Esc or the backdrop cancels
 *   JoyaUI.openModal(el) / JoyaUI.closeModal(el)
 *       a server-rendered .cc-modal form dialog (Users, Roles, the voice
 *       token): shown over a scrim, Esc / the scrim / [data-modal-close] close
 *
 * A form with data-confirm="Question?" (the old attribute), or
 * data-confirm-dlg="Title" with data-confirm-body / data-confirm-yes /
 * data-confirm-danger="0", asks through the confirm before it submits -- no
 * more window.confirm. The button that submitted it is carried over.
 */
window.JoyaUI = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function confirmDlg(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var back = document.createElement("div");
      back.className = "cc-sdlg-back";
      back.innerHTML =
        '<div class="cc-sdlg" role="alertdialog" aria-modal="true" aria-labelledby="joya-dlg-t"><h3 id="joya-dlg-t">' + esc(o.title || "Are you sure?") + "</h3>" +
        (o.body ? "<p>" + esc(o.body) + "</p>" : "") +
        '<div class="acts"><button type="button" class="cc-btn" data-a="no">' + esc(o.no || "Cancel") + '</button><button type="button" class="cc-btn ' +
        (o.danger === false ? "pri" : "danger") + '" data-a="yes">' + esc(o.yes || "Confirm") + "</button></div></div>";
      document.body.appendChild(back);
      var prev = document.activeElement;
      back.querySelector('[data-a="no"]').focus();
      function done(v) {
        back.remove();
        if (prev && prev.focus) prev.focus();
        resolve(v);
      }
      back.addEventListener("click", function (e) {
        if (e.target === back) return done(false);
        var b = e.target.closest("[data-a]");
        if (b) done(b.getAttribute("data-a") === "yes");
      });
      back.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      });
    });
  }
  var scrim = null;
  var openEl = null;
  var opener = null;
  function closeModal(el) {
    el = el || openEl;
    if (!el) return;
    el.hidden = true;
    if (scrim) scrim.hidden = true;
    openEl = null;
    if (opener && opener.focus) opener.focus();
    opener = null;
  }
  function openModal(el) {
    if (!el) return;
    if (openEl) closeModal(openEl);
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "cc-scrim os";
      scrim.hidden = true;
      scrim.addEventListener("click", function () { closeModal(); });
      document.body.appendChild(scrim);
    }
    if (el.parentNode !== document.body) document.body.appendChild(el);
    opener = document.activeElement;
    scrim.hidden = false;
    el.hidden = false;
    openEl = el;
    var first = el.querySelector("input:not([type=hidden]):not([disabled]):not([readonly]), select, textarea");
    if (first) first.focus();
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-modal-open]");
    if (t) {
      e.preventDefault();
      openModal(document.getElementById(t.getAttribute("data-modal-open")));
      return;
    }
    if (e.target.closest && e.target.closest("[data-modal-close]")) {
      e.preventDefault();
      closeModal();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openEl && !document.querySelector(".cc-sdlg-back")) closeModal();
  });
  return { confirm: confirmDlg, openModal: openModal, closeModal: closeModal, esc: esc };
})();

document.addEventListener("submit", function (ev) {
  var form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.__joyaConfirmed || form.hasAttribute("data-live")) return; // os.js sends live forms (and asks first)
  var title = form.getAttribute("data-confirm-dlg") || form.getAttribute("data-confirm");
  if (!title) return;
  ev.preventDefault();
  var submitter = ev.submitter || null;
  window.JoyaUI.confirm({
    title: title,
    body: form.getAttribute("data-confirm-body") || "",
    yes: form.getAttribute("data-confirm-yes") || "Confirm",
    no: form.getAttribute("data-confirm-no") || "Cancel",
    danger: form.getAttribute("data-confirm-danger") !== "0",
  }).then(function (ok) {
    if (!ok) return;
    // form.submit() skips the submit event (and the button that was pressed):
    // carry the button's name and value over as a hidden field.
    if (submitter && submitter.name) {
      var h = document.createElement("input");
      h.type = "hidden";
      h.name = submitter.name;
      h.value = submitter.value;
      form.appendChild(h);
    }
    form.__joyaConfirmed = true;
    HTMLFormElement.prototype.submit.call(form);
  });
});

/* Live-refresh the overview tiles without a full page reload. */
(function () {
  var grid = document.querySelector("[data-live-stats]");
  if (!grid) return;

  function fmtBytes(n) {
    if (n == null) return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  function setMeter(name, used, total) {
    var el = document.querySelector('[data-meter="' + name + '"]');
    if (!el || !total) return;
    var pct = Math.round((used / total) * 100);
    var fill = el.querySelector(".fill");
    var label = el.querySelector(".meter-head span:last-child");
    fill.style.width = pct + "%";
    fill.className = "fill " + (pct > 90 ? "bad" : pct > 75 ? "warn" : "ok");
    if (label) label.textContent = fmtBytes(used) + " / " + fmtBytes(total);
  }

  function refresh() {
    fetch("/api/stats", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("stats unavailable");
        return r.json();
      })
      .then(function (d) {
        setMeter("memory", d.stats.memUsed, d.stats.memTotal);
        setMeter("disk", d.stats.diskUsed, d.stats.diskTotal);
        var sshd = (d.status.jails && d.status.jails.sshd) || null;
        if (sshd) {
          var banned = document.querySelector('[data-stat="banned"]');
          var failed = document.querySelector('[data-stat="failed"]');
          if (banned) banned.textContent = sshd.banned;
          if (failed) failed.textContent = sshd.total_failed;
        }
      })
      .catch(function () {
        /* transient failure: leave the last-known values on screen */
      });
  }

  setInterval(refresh, 15000);
})();

/*
 * Claude Code > Running: swap the live tables in place every ten seconds.
 *
 * The server renders the fragments with the same view code as the page, so
 * nothing is templated here and every value arrives already escaped. Skipped
 * while the tab is hidden, and while a confirm dialog or a focused control is
 * in play, so a table never changes under a click. Without JavaScript the page
 * is complete as served and a reload is the refresh.
 */
(function () {
  var root = document.querySelector("[data-cc-running]");
  if (!root) return;
  var busy = false;

  function refresh() {
    if (busy || document.hidden) return;
    var focused = document.activeElement;
    if (focused && focused !== document.body && root.contains(focused)) return;
    busy = true;
    fetch("/api/claude/running", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("running view unavailable");
        return r.json();
      })
      .then(function (d) {
        var html = d.html || {};
        Object.keys(html).forEach(function (key) {
          var el = root.querySelector('[data-cc-section="' + key + '"]');
          if (el) el.innerHTML = html[key];
        });
        var stamp = root.querySelector("[data-cc-updated]");
        if (stamp && d.updated) stamp.textContent = d.updated;
      })
      .catch(function () {
        /* signed out or a transient failure: keep what is on screen */
      })
      .then(function () {
        busy = false;
      });
  }

  setInterval(refresh, 10000);
})();

/*
 * The two drawers.
 *
 * Below 900px the sidebar and the console's chat list stop being columns and
 * become panels that slide in over the page. Both are the same mechanism: a
 * class on <html>, a button that toggles it, and a scrim that closes it. The
 * markup is identical at every width -- only the stylesheet decides whether a
 * drawer is a drawer -- so nothing here has to know the viewport, and a desktop
 * that happens to run this code toggles a class no rule reads.
 *
 * Delegated from the document because the console replaces its own topline as
 * chats come and go, and a listener bound to a button would go with it.
 */
(function () {
  var root = document.documentElement;

  var DRAWERS = [
    { open: "nav-open", toggle: "data-nav-toggle", close: "data-nav-close", scrim: ".nav-scrim" },
    { open: "chats-open", toggle: "data-chats-toggle", close: "data-chats-close", scrim: ".chat-scrim" },
    // The Command Center: its sidebar is a drawer at every width, opened by the
    // ☰ at the bottom of its icon bar (and by the top bar's ☰ on a phone).
    { open: "os-drawer", toggle: "data-os-toggle", close: "data-os-close", scrim: ".os-scrim", always: true },
  ];

  function setOpen(d, on) {
    root.classList.toggle(d.open, on);
    var buttons = document.querySelectorAll("[" + d.toggle + "]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-expanded", on ? "true" : "false");
    }
    // hidden rather than opacity alone: a scrim left in the layer soaks up taps
    // meant for the page behind it, which reads as the whole app going dead.
    var scrim = document.querySelector(d.scrim);
    if (scrim) scrim.hidden = !on;
  }

  function closeAll() {
    for (var i = 0; i < DRAWERS.length; i++) setOpen(DRAWERS[i], false);
  }

  document.addEventListener("click", function (ev) {
    for (var i = 0; i < DRAWERS.length; i++) {
      var d = DRAWERS[i];
      if (ev.target.closest("[" + d.toggle + "]")) {
        ev.preventDefault();
        var on = !root.classList.contains(d.open);
        closeAll();
        setOpen(d, on);
        return;
      }
      if (ev.target.closest("[" + d.close + "]")) {
        setOpen(d, false);
        return;
      }
    }
    // Following a link inside a drawer navigates; leaving it open would mean
    // the new page arrives with a panel over it.
    if (ev.target.closest(".sidebar a, .chat-list a")) closeAll();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !document.querySelector(".cc-sdlg-back")) closeAll();
  });

  // A drawer is a small-screen state. Coming back to a wide window with one
  // still "open" would leave the class on and, with it, a scrim nobody can see.
  var wide = window.matchMedia("(min-width: 901px)");
  (wide.addEventListener ? wide.addEventListener.bind(wide, "change") : wide.addListener.bind(wide))(
    function (e) {
      if (!e.matches) return;
      for (var i = 0; i < DRAWERS.length; i++) if (!DRAWERS[i].always) setOpen(DRAWERS[i], false);
    }
  );
})();

/*
 * The theme switch: System / Dark / Light, in the top bar of every page.
 *
 * theme-init.js has already applied the saved choice before the first paint;
 * this ticks the matching button and handles changes. "System" removes the
 * attribute so the stylesheet's prefers-color-scheme rules decide, live, as
 * the operating system changes. Storage can be blocked (a private window,
 * cleared site data), so every access is guarded and the page still works --
 * it just forgets the choice.
 *
 * A change is announced as a "joya-theme" event on the document, which the
 * Command Center uses to repaint its canvas in the new palette.
 */
(function () {
  // The avatar menu holds one; Settings > Appearance another. Both stay in step.
  var groups = document.querySelectorAll("[data-theme-switch]");
  if (!groups.length) return;
  var root = document.documentElement;
  var ORDER = ["system", "dark", "light"];

  function current() {
    var t = root.getAttribute("data-theme");
    return t === "dark" || t === "light" ? t : "system";
  }
  function tick(pref) {
    var bs = document.querySelectorAll("[data-theme-switch] button[data-theme-opt]");
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute("data-theme-opt") === pref;
      bs[i].setAttribute("aria-checked", on ? "true" : "false");
      bs[i].tabIndex = on ? 0 : -1;
    }
  }
  function apply(pref) {
    if (ORDER.indexOf(pref) < 0) pref = "system";
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    try {
      window.localStorage.setItem("joya-theme", pref);
    } catch (e) {
      /* storage blocked: the choice lasts until the page is left */
    }
    tick(pref);
    document.dispatchEvent(new CustomEvent("joya-theme", { detail: { theme: pref } }));
  }

  tick(current());
  Array.prototype.forEach.call(groups, function (group) {
    group.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-theme-opt]");
      if (b) apply(b.getAttribute("data-theme-opt"));
    });
    group.addEventListener("keydown", function (ev) {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      ev.preventDefault();
      var i = (ORDER.indexOf(current()) + (ev.key === "ArrowRight" ? 1 : 2)) % 3;
      apply(ORDER[i]);
      var b = group.querySelector('button[data-theme-opt="' + ORDER[i] + '"]');
      if (b) b.focus();
    });
  });
  // Following the system, a change there is a change here.
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  if (mq) {
    var onChange = function () {
      if (current() === "system") document.dispatchEvent(new CustomEvent("joya-theme", { detail: { theme: "system" } }));
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();

/*
 * The bridge to the Command Center's shell (M-5 part 2) -- only when this page
 * is inside its frame (same origin, a parent that is the shell). It tells the
 * shell where it is and its title, and keeps the theme in step both ways.
 * (Space held to talk went with push to talk: voice is live conversation,
 * started from the dock's mic.) A signed-out page (login,
 * an expired session), a logout and the Command Center itself leave the frame.
 * Messages go to this origin only, and are taken only from the parent.
 */
(function () {
  var parent = null;
  try {
    if (window.top !== window && window.parent === window.top && window.top.location.origin === location.origin && window.top.JoyaShell) parent = window.top;
  } catch (e) {
    parent = null;
  }
  if (!parent) return;
  var ORIGIN = location.origin;
  var send = function (m) { try { parent.postMessage(m, ORIGIN); } catch (e) { /* the shell is gone */ } };
  // Signed out (the sign-in page, a session that expired): the whole tab goes there.
  if (document.querySelector(".auth-wrap")) {
    parent.location.replace(location.pathname + location.search);
    return;
  }
  var cc = function (path) { return path === "/joya-ai" || path === "/joya-ai/"; };
  if (cc(location.pathname)) return send({ joya: "expand" });
  // Logout leaves the frame with the whole tab.
  var forms = document.querySelectorAll('form[action="/logout"]');
  for (var i = 0; i < forms.length; i++) forms[i].target = "_top";
  // A link to the Command Center brings it back rather than nesting it.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
    var u;
    try { u = new URL(a.href); } catch (x) { return; }
    if (u.origin === ORIGIN && cc(u.pathname) && !u.search) { e.preventDefault(); send({ joya: "expand" }); }
  }, true);
  var nav = function () { send({ joya: "nav" }); };
  window.addEventListener("hashchange", nav);
  window.addEventListener("popstate", nav);
  // The theme, both ways (the switch here, or the shell's).
  document.addEventListener("joya-theme", function (e) { send({ joya: "theme", theme: (e.detail && e.detail.theme) || "system" }); });
  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || e.source !== parent) return;
    var m = e.data && typeof e.data === "object" ? e.data : {};
    if (m.joya !== "theme" || ["system", "dark", "light"].indexOf(m.theme) < 0) return;
    var root = document.documentElement, now = root.getAttribute("data-theme") || "system";
    if (now === m.theme) return;
    var b = document.querySelector('[data-theme-switch] button[data-theme-opt="' + m.theme + '"]');
    if (b) return b.click();
    if (m.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", m.theme);
  });
  nav();
})();

/* Channel ▸ Telegram Topics (lib/views-channels.js renderTopics): add and remove
 * project rows from the <template>, show the group-only settings (chat id,
 * General, new-topic folders, trash) only in group mode, and keep the
 * "General goes to" choices in step with the list's own projects (rows marked
 * auto and rows switched off are not choices). The helper validates everything
 * again on save. */
(function () {
  function refreshGeneral(box) {
    var sel = box && box.querySelector("[data-topics-general]");
    if (!sel) return;
    var current = sel.value;
    var keep = sel.options[0] ? sel.options[0].cloneNode(true) : null;
    var seen = {};
    var choices = [];
    box.querySelectorAll("[data-topics-row]:not([data-topics-auto])").forEach(function (row) {
      if (row.closest("template")) return;
      var name = (row.querySelector("input[name=tp_name]") || {}).value || "";
      var slug = ((row.querySelector("input[name=tp_slug]") || {}).value || "").trim().toLowerCase();
      var on = (row.querySelector("select[name=tp_on]") || {}).value !== "0";
      if (!slug) slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").replace(/-{2,}/g, "-").slice(0, 40).replace(/[-_]+$/g, "");
      if (!slug || !on || seen[slug]) return;
      seen[slug] = 1;
      choices.push([slug, name.trim() || slug]);
    });
    sel.textContent = "";
    if (keep) sel.appendChild(keep);
    choices.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c[0];
      o.textContent = c[1];
      sel.appendChild(o);
    });
    sel.value = seen[current] ? current : "";
  }
  document.addEventListener("input", function (e) {
    var box = e.target.closest && e.target.closest("[data-topics]");
    if (box && e.target.closest("[data-topics-row]")) refreshGeneral(box);
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-topics-add], [data-topics-remove]");
    if (!t) return;
    var box = t.closest("[data-topics]");
    if (!box) return;
    e.preventDefault();
    if (t.hasAttribute("data-topics-remove")) {
      var row = t.closest("[data-topics-row]");
      if (row) row.remove();
      refreshGeneral(box);
      return;
    }
    var tpl = box.querySelector("template[data-topics-template]");
    var body = box.querySelector("[data-topics-body]");
    if (!tpl || !body || body.children.length >= 20) return;
    body.appendChild(tpl.content.cloneNode(true));
    var inputs = body.querySelectorAll("input[name=tp_name]");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  document.addEventListener("change", function (e) {
    var on = e.target.closest && e.target.closest("[data-topics-row] select[name=tp_on]");
    if (on) refreshGeneral(on.closest("[data-topics]"));
    var sel = e.target.closest && e.target.closest("[data-topics-mode]");
    if (!sel) return;
    var box = sel.closest("[data-topics]");
    if (!box) return;
    box.querySelectorAll("[data-topics-chat], [data-topics-group]").forEach(function (el) {
      el.hidden = sel.value !== "group";
    });
  });
})();
