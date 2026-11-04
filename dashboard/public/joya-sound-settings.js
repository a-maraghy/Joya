"use strict";
/*
 * Settings > Appearance > Sounds (2026-10-20): JOYA AI's sounds (public/joya-sound.js). Each change is
 * saved at once through POST /joya-ai/api/prefs/sound (CSRF in a header) and handed to an open Command
 * Center through a storage event ("joya-sound"); the volume saves when the slider is let go. "This
 * browser" is this browser's own switch (localStorage, never sent). The Listen buttons play a sound
 * now at the chosen volume (the click unlocks the audio). No inline style or script (the CSP).
 */
(function () {
  var box = document.getElementById("joya-sound-set");
  var M = window.JoyaSound;
  if (!box || !M) return;
  box.classList.add("js");
  var CSRF = box.getAttribute("data-csrf") || "";
  var note = document.getElementById("joya-sound-note");
  M.setPrefs(box.getAttribute("data-sound") || "");
  function el(k) { return box.querySelector('[data-snd="' + k + '"]'); }
  function say(t, bad) { if (!note) return; note.textContent = t; note.classList.toggle("err", !!bad); }
  var out = box.querySelector("[data-snd-out]");
  var br = el("browser");
  if (br) br.checked = M.browserOn();
  function paint() {
    var p = M.prefs();
    box.classList.toggle("snd-off", !p.on);
    box.classList.toggle("snd-noquiet", !p.quiet);
    if (out) out.textContent = el("vol").value + " %";
  }
  paint();

  var seq = 0;
  function save(edit) {
    var my = ++seq;
    say("Saving…");
    M.setPrefs(Object.assign(M.prefs(), edit)); // the previews follow at once
    paint();
    return fetch("/joya-ai/api/prefs/sound", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify(edit),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        if (my !== seq) return;
        M.setPrefs(j.sound);
        box.setAttribute("data-sound", JSON.stringify(j.sound));
        paint();
        say("Saved. Sounds: " + j.line + ".");
        try { window.localStorage.setItem("joya-sound", JSON.stringify({ sound: j.sound, at: Date.now() })); } catch (x) { /* the Command Center reads it on its next load */ }
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  }

  box.addEventListener("change", function (e) {
    var k = e.target.getAttribute("data-snd");
    if (k === "on" || k === "quiet") return save(k === "on" ? { on: e.target.checked } : { quiet: e.target.checked });
    if (k === "vol") return save({ vol: Math.round(Number(e.target.value)) });
    if (k === "from" || k === "to") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) return say("Quiet hours need a time (HH:MM).", true);
      var ed = {}; ed[k] = e.target.value;
      return save(ed);
    }
    if (k === "browser") {
      M.setBrowserOn(e.target.checked);
      if (e.target.checked) M.unlock();
      say(e.target.checked ? "This browser plays the sounds now (while the Command Center is open in it)." : "This browser stays silent.");
    }
  });
  box.addEventListener("input", function (e) { if (e.target.getAttribute("data-snd") === "vol" && out) out.textContent = e.target.value + " %"; });

  box.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-snd-try]");
    if (!b) return;
    var role = box.querySelector("[data-snd-role]");
    var p = M.prefs();
    // A preview at the slider's volume (even before it is saved), whatever the switches say: it was asked for.
    M.setPrefs(Object.assign({}, p, { vol: Math.round(Number(el("vol").value)) }));
    Promise.resolve(M.preview(b.getAttribute("data-snd-try"), { role: role ? role.value : "core" })).then(function (ok) {
      M.setPrefs(p);
      if (!ok) say("This browser cannot play sound here.", true);
      else if (!Number(el("vol").value)) say("The volume is at 0.");
    });
  });
})();
