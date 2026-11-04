"use strict";
/*
 * JOYA AI ▸ Settings ▸ Voice, in the browser:
 *   - the line under the Voice model selector follows the option chosen (the
 *     form itself is posted by os.js);
 *   - each voice card's play button (lib/views-settings-voice.js voiceCard):
 *     POST /joya-ai/settings/voice/sample {voice, _csrf} -> audio/wav, played
 *     here. It does not choose the voice (the button sits beside the radio
 *     label, and is type="button"). States on the button: data-state
 *     "loading" (the clip is being made: ~1.5 s on a realtime model, ~5 s on
 *     GPT-Live the first time; kept on the server after that), "playing"
 *     (a click stops it), and an error line under the cards. One sample plays
 *     at a time. Without JavaScript the buttons stay hidden.
 * The "Read replies aloud" switch that lived here was removed on 2026-10-30.
 */
(function () {
  [["voice-model", "voice-model-hint"]].forEach(function (ids) {
    var pick = document.getElementById(ids[0]);
    var hint = document.getElementById(ids[1]);
    if (!pick || !hint) return;
    pick.addEventListener("change", function () {
      var o = pick.options[pick.selectedIndex];
      hint.textContent = (o && o.getAttribute("data-hint")) || "";
    });
  });
})();
(function () {
  var buttons = document.querySelectorAll(".voice-play[data-sample]");
  if (!buttons.length) return;
  var form = buttons[0].closest("form");
  var csrfEl = form && form.querySelector('input[name="_csrf"]');
  var msg = document.getElementById("voice-sample-msg");
  if (!csrfEl || typeof window.Audio !== "function") return;
  var cur = null; // { btn, audio, ctrl, url }
  var clips = {}; // voice -> object URL, for this page's life

  function setState(btn, st) {
    if (st) btn.setAttribute("data-state", st);
    else btn.removeAttribute("data-state");
    var name = btn.getAttribute("data-name");
    btn.setAttribute("aria-label", st === "playing" ? "Stop the sample of " + name : st === "loading" ? "Loading the sample of " + name : "Play a sample of " + name);
    btn.setAttribute("aria-pressed", st === "playing" ? "true" : "false");
    if (st === "loading") btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }
  function say(text) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.hidden = !text;
  }
  function stop() {
    if (!cur) return;
    var c = cur;
    cur = null;
    if (c.ctrl) {
      try { c.ctrl.abort(); } catch (e) { /* done */ }
    }
    if (c.audio) {
      try { c.audio.pause(); } catch (e) { /* gone */ }
    }
    setState(c.btn, null);
  }
  function play(btn, url) {
    var audio = new window.Audio(url);
    cur.audio = audio;
    setState(btn, "playing");
    audio.addEventListener("ended", function () { if (cur && cur.btn === btn) { cur = null; setState(btn, null); } });
    audio.addEventListener("error", function () { if (cur && cur.btn === btn) { cur = null; setState(btn, null); say("This browser could not play the sample."); } });
    var p = audio.play();
    if (p && p.catch) p.catch(function () { if (cur && cur.btn === btn) { cur = null; setState(btn, null); say("This browser blocked the sound. Click again to play it."); } });
  }
  function start(btn) {
    var voice = btn.getAttribute("data-sample");
    say("");
    cur = { btn: btn, audio: null, ctrl: null };
    if (clips[voice]) return play(btn, clips[voice]);
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    cur.ctrl = ctrl;
    setState(btn, "loading");
    fetch("/joya-ai/settings/voice/sample", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "audio/wav, application/json", "X-Requested-With": "fetch", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfEl.value, voice: voice }).toString(),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) {
        var type = r.headers.get("content-type") || "";
        if (r.ok && /^audio\//.test(type)) return r.blob();
        return r.json().catch(function () { return {}; }).then(function (d) { throw new Error((d && d.error) || "The sample could not be played (" + r.status + ")."); });
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        clips[voice] = url;
        if (!cur || cur.btn !== btn) return; // stopped while it loaded
        cur.ctrl = null;
        play(btn, url);
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") return;
        if (cur && cur.btn === btn) cur = null;
        setState(btn, null);
        say(btn.getAttribute("data-name") + ": " + ((e && e.message) || "the sample could not be played."));
      });
  }
  Array.prototype.forEach.call(buttons, function (btn) {
    var name = (btn.getAttribute("aria-label") || "").replace(/^Play a sample of /, "") || btn.getAttribute("data-sample");
    btn.setAttribute("data-name", name);
    btn.setAttribute("aria-pressed", "false");
    btn.hidden = false;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      var mine = cur && cur.btn === btn;
      stop();
      if (!mine) start(btn);
    });
  });
  window.addEventListener("pagehide", stop);
})();
