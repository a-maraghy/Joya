"use strict";
/* The Settings window: reads the app's settings, lets you change them, saves through settings_set
   (which checks the hotkeys again and applies everything at once). */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T.core.invoke(c, a || {}); };
  var $ = function (id) { return document.getElementById(id); };
  var S = null, monKey = null, saved = "", discard = false;

  function segs() {
    document.querySelectorAll(".seg[data-k]").forEach(function (s) {
      var k = s.getAttribute("data-k"), v = val(k);
      s.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === v); });
    });
  }
  function pm() {
    S.per_monitor = S.per_monitor || {};
    if (!monKey) monKey = "default";
    S.per_monitor[monKey] = S.per_monitor[monKey] || { corner: "br", across: "right", size: "M", opacity: 100 };
    return S.per_monitor[monKey];
  }
  function comp() { S.companion = S.companion || { stay_on_monitor: false }; return S.companion; }
  // Eye contact (presence.rs): off by default; "consented" is the app's own record, kept as it is.
  function pres() { S.presence = S.presence || { camera: false, look_and_speak: false, release_on_saver: true, consented: false }; return S.presence; }
  $("cam-on").addEventListener("change", function () { $("cam-speak").disabled = !this.checked; if (!this.checked) $("cam-speak").checked = false; });
  if (location.hash === "#eye-contact") setTimeout(function () { var h = $("eye-contact"); if (h && h.scrollIntoView) h.scrollIntoView(); }, 300);
  function val(k) { return k === "mode" ? S.mode : pm()[k]; }
  function setVal(k, v) { if (k === "mode") S.mode = v; else pm()[k] = v; segs(); }
  document.querySelectorAll(".seg[data-k]").forEach(function (s) {
    s.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setVal(s.getAttribute("data-k"), b.getAttribute("data-v")); });
  });

  // Recording a hotkey: the next key press with Ctrl or Alt.
  function keyName(e) {
    var k = e.code;
    if (/^Key[A-Z]$/.test(k)) return k.slice(3);
    if (/^Digit\d$/.test(k)) return k.slice(5);
    if (/^F\d{1,2}$/.test(k)) return k;
    return { Space: "Space", Enter: "Enter", Tab: "Tab", Backquote: "Backquote" }[k] || null;
  }
  ["talk", "live", "show", "focus"].forEach(function (n) {
    var el = $("hk-" + n);
    el.addEventListener("focus", function () { el.classList.add("rec"); el.value = "press the keys…"; });
    el.addEventListener("blur", function () { el.classList.remove("rec"); el.value = S.hotkeys[n]; });
    el.addEventListener("keydown", function (e) {
      e.preventDefault();
      var k = keyName(e);
      if (!k || !(e.ctrlKey || e.altKey)) return;
      S.hotkeys[n] = [e.ctrlKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", k].filter(Boolean).join("+");
      el.blur();
    });
  });

  function paint(v) {
    S = v.settings;
    discard = false;
    monKey = v.monitorKey || monKey;
    $("ver").textContent = "version " + v.version + (v.update ? " · " + v.update + " is ready (tray ▸ Update)" : "");
    var sel = $("monitor");
    sel.innerHTML = "";
    var o0 = document.createElement("option"); o0.value = ""; o0.textContent = "The primary monitor"; sel.appendChild(o0);
    (v.monitors || []).forEach(function (m) { var o = document.createElement("option"); o.value = m; o.textContent = m.replace(/^\\\\\.\\/, ""); sel.appendChild(o); });
    sel.value = S.monitor || "";
    $("focus").checked = !!S.focus;
    $("glance").checked = S.glance !== false;
    $("comp-stay").checked = !!comp().stay_on_monitor;
    $("cam-on").checked = !!pres().camera; $("cam-speak").checked = !!pres().look_and_speak; $("cam-saver").checked = pres().release_on_saver !== false;
    $("cam-speak").disabled = !pres().camera;
    $("dnd").checked = !!S.do_not_disturb;
    $("batt").checked = !!S.battery_saver;
    $("blur").checked = S.real_blur !== false;
    // Why real blur cannot be drawn here (the setting still saves; the tinted look is used meanwhile).
    var bn = $("blur-note");
    if (!bn.getAttribute("data-base")) bn.setAttribute("data-base", bn.textContent);
    bn.textContent = v.blurNote ? v.blurNote : bn.getAttribute("data-base");
    bn.classList.toggle("warn", !!v.blurNote);
    $("autostart").checked = !!S.autostart;
    $("updates").checked = !!S.check_updates;
    $("hk-talk").value = S.hotkeys.talk; $("hk-show").value = S.hotkeys.show; $("hk-focus").value = S.hotkeys.focus; $("hk-live").value = S.hotkeys.live || "";
    $("live-note").textContent = v.liveFallback ? "Ctrl+Alt+L is taken by another app: using " + v.liveKey + " for now." : v.liveKey ? "Now: press " + v.liveKey + " once to start, again to end." : "Not set: the key is taken by another app.";
    $("talk-note").textContent = v.talkFallback ? "Ctrl+Space is taken by another app: listening on " + v.talkKey + " for now." : v.talkKey ? "Now: hold " + v.talkKey + "." : "Not set: the key is taken by another app.";
    $("opacity").value = pm().opacity; $("opv").textContent = pm().opacity + "%";
    segs();
    if (window.JoyaMachine) window.JoyaMachine.paint(S); // "This computer" (below)
    // What is saved, as the form reads it (the per-monitor entry above may have just been made).
    collect();
    saved = JSON.stringify(S);
  }
  $("opacity").addEventListener("input", function () { pm().opacity = Number(this.value); $("opv").textContent = this.value + "%"; });
  /** The form's values into S (segments, hotkeys and opacity are written as they change). */
  function collect() {
    S.monitor = $("monitor").value;
    S.focus = $("focus").checked; S.do_not_disturb = $("dnd").checked; S.battery_saver = $("batt").checked; S.real_blur = $("blur").checked;
    S.glance = $("glance").checked;
    S.companion = { stay_on_monitor: $("comp-stay").checked };
    pres().camera = $("cam-on").checked; pres().look_and_speak = $("cam-on").checked && $("cam-speak").checked; pres().release_on_saver = $("cam-saver").checked;
    S.autostart = $("autostart").checked; S.check_updates = $("updates").checked;
    if (window.JoyaMachine) window.JoyaMachine.collect(S);
  }
  function save() {
    collect();
    $("err").textContent = "";
    return invoke("settings_set", { value: S }).then(function () { return invoke("settings_get"); }).then(function (v) { paint(v); $("err").textContent = "Saved."; return true; })
      .catch(function (e) { $("err").textContent = String(e); return false; });
  }
  $("save").addEventListener("click", function () { save(); });
  /*
   * Close: the app closes this window (settings_close). The page closing itself is not it: WebView2 empties the
   * page and leaves the window up, white. Unsaved changes: the first Close says so; Save, or Close
   * again to discard them. Esc is Close (not while a hotkey box is recording).
   */
  function close() {
    if (S) collect();
    if (S && JSON.stringify(S) !== saved && !discard) {
      discard = true;
      $("err").textContent = "You have unsaved changes: Save them, or press Close again to discard them.";
      return false;
    }
    invoke("settings_close").catch(function (e) { $("err").textContent = String(e); });
    return true;
  }
  $("cancel").addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.activeElement && document.activeElement.classList.contains("key")) { document.activeElement.blur(); return; }
    close();
  });
  window.JoyaSettings = { close: close, save: save, dirty: function () { if (S) collect(); return !!S && JSON.stringify(S) !== saved; } };
  $("upd").addEventListener("click", function () { invoke("settings_check_update"); $("err").textContent = "Checking… a notification says what was found."; });
  invoke("settings_get").then(paint);
})();

/* "This computer" and "Claude Code": pairing with Joya (machine_link / machine_unlink, the token goes
   to Windows Credential Manager, never here), the stop key and the CLI's path (both saved with Save,
   through the form above: paint / collect are called from it). */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T.core.invoke(c, a || {}); };
  var $ = function (id) { return document.getElementById(id); };
  var stopKey = "Ctrl+Alt+Esc", cpath = "", painted = false;

  function show(st) {
    if (!st) return;
    var s = !st.linked ? "Not linked." : "Linked as " + (st.name || "this computer") + " to " + st.server + " · " + (st.online ? "online" : "offline, reconnecting");
    if (st.lease) s += " · JOYA AI is controlling it now (" + st.lease.left + " left)";
    $("m-status").textContent = s;
    $("m-unlink").hidden = !st.linked;
    $("m-pair").hidden = !!st.linked;
    if (!$("m-name").value) $("m-name").value = st.computer || "";
    var c = st.claude || {};
    $("m-claude").textContent = !c.checked ? "Looking…" : c.path ? c.path + (c.version ? " · version " + c.version : " · it did not say its version") + (c.git_bash ? "" : " · no Git Bash: it will use PowerShell")
      : "Not found — install Claude Code and sign in once by running `claude` in a terminal.";
    if (c.checked) {
      $("m-chrome").textContent = st.chrome ? "Found in " + st.chrome + ". JOYA AI can use your Chrome through it while it is in control; sending, buying, posting and signing in wait for your approval."
        : "Not found. Install Claude in Chrome from claude.ai/chrome, sign in with the same Claude account as Claude Code, then press Look again.";
      $("m-office").textContent = (st.office && st.office.length) ? st.office.join(", ") + " — used to edit files and make PDFs (macros always off)." : "Not installed: files are edited directly; making PDFs needs Office.";
    }
    $("stop-note").textContent = st.stop_fallback ? "Ctrl+Alt+Esc is taken by another app: using " + st.stop_key + " for now." : st.stop_key ? "Now: " + st.stop_key + ". Ends control at once, here on this computer." : "Not set: the key is taken by another app (the pill's Stop always works).";
    if (st.error) $("m-err").textContent = st.error;
  }
  function refresh() { return invoke("machine_status").then(show).catch(function () {}); }

  // The stop key: recorded like the others, and Esc is allowed here (only with Ctrl+Alt).
  var el = $("hk-stop");
  el.addEventListener("focus", function () { el.classList.add("rec"); el.value = "press the keys…"; });
  el.addEventListener("blur", function () { el.classList.remove("rec"); el.value = stopKey; });
  el.addEventListener("keydown", function (e) {
    e.preventDefault();
    var c = e.code, k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c : c === "Escape" ? "Esc" : null;
    if (!k || !(e.ctrlKey || e.altKey)) return;
    if (k === "Esc" && !(e.ctrlKey && e.altKey)) return;
    stopKey = [e.ctrlKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", k].filter(Boolean).join("+");
    el.blur();
  });
  $("hk-stop-def").addEventListener("click", function () { stopKey = "Ctrl+Alt+Esc"; el.value = stopKey; });

  $("m-link").addEventListener("click", function () {
    $("m-err").textContent = "Linking…";
    invoke("machine_link", { code: $("m-code").value, name: $("m-name").value }).then(function (st) { $("m-code").value = ""; $("m-err").textContent = "Linked."; show(st); })
      .catch(function (e) { $("m-err").textContent = String(e); });
  });
  $("m-code").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("m-link").click(); } });
  $("m-unlink").addEventListener("click", function () {
    if ($("m-unlink").dataset.sure !== "1") { $("m-unlink").dataset.sure = "1"; $("m-err").textContent = "Press Unlink again to unlink this computer (any control in progress stops)."; return; }
    $("m-unlink").dataset.sure = "";
    invoke("machine_unlink").then(function (st) { $("m-err").textContent = "Unlinked. Remove it in Joya too if you will not link it again."; show(st); }).catch(function (e) { $("m-err").textContent = String(e); });
  });
  $("m-recheck").addEventListener("click", function () {
    if ($("m-cpath").value.trim() !== cpath) { $("m-err").textContent = "Save first: the new path is used once it is saved."; return; }
    $("m-claude").textContent = "Looking…";
    invoke("machine_claude_check").then(show).catch(function (e) { $("m-err").textContent = String(e); });
  });

  window.JoyaMachine = {
    paint: function (S) {
      S.hotkeys = S.hotkeys || {};
      stopKey = S.hotkeys.stop || "Ctrl+Alt+Esc";
      cpath = S.claude_path || "";
      el.value = stopKey;
      $("m-cpath").value = cpath;
      painted = true;
    },
    collect: function (S) {
      if (!painted) return;
      S.hotkeys.stop = stopKey;
      S.claude_path = $("m-cpath").value.trim();
    }
  };
  refresh();
  setInterval(refresh, 2000);
})();
