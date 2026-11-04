/*
 * Enrol your voiceprint (/joya-ai/voiceprint/enrol; lib/voiceprint-routes.js).
 * Records each paragraph with the live call's own capture worklet and
 * microphone settings (24 kHz PCM16; echo cancellation, noise suppression and
 * auto gain on, as public/voice-live.js), so the voiceprint is made from what a
 * live call hears. Each recording is sent once; the server embeds it and keeps
 * only the numbers.
 */
(function () {
  "use strict";
  var root = document.getElementById("vpe");
  if (!root) return;
  var CSRF = root.getAttribute("data-csrf") || "";
  var WORKLET = root.getAttribute("data-worklet") || "/static/voice-live-worklet.js";
  var NEED = Number(root.getAttribute("data-need")) || 30;
  var PERSON = root.getAttribute("data-person") || "";
  var AC = window.AudioContext || window.webkitAudioContext;
  var rec = null;

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function slot() { return $("#vp-slot").value; }
  function state(id, text, cls) { var s = $('[data-state="' + id + '"]'); if (s) { s.textContent = text; s.className = "vp-state small " + (cls || "muted"); } }
  function json(r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; }); }
  function wav(int16) {
    var b = new ArrayBuffer(44 + int16.length * 2), v = new DataView(b);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + int16.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, int16.length * 2, true);
    new Int16Array(b, 44).set(int16);
    return b;
  }
  function total(s) {
    $("#vpe-total").textContent = s + " s of speech" + (s >= NEED ? " — enough" : " of the " + NEED + " s needed");
    $("#vpe-save").disabled = !(s >= NEED);
  }

  function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (ds) {
      var sel = $("#vp-device"), cur = sel.value, keep = sel.options[0], named = 0;
      sel.innerHTML = "";
      sel.appendChild(keep);
      ds.filter(function (d) { return d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"; }).forEach(function (d, i) {
        var o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "Microphone " + (i + 1);
        if (d.label) named++;
        sel.appendChild(o);
      });
      if (cur && $$("option", sel).some(function (o) { return o.value === cur; })) sel.value = cur;
      $("#vp-allow").hidden = named > 0;
      if (named) $("#vp-mic-note").textContent = "Pick the microphone you will use with JOYA AI.";
    }).catch(function () {});
  }
  $("#vp-allow").addEventListener("click", function () {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); listDevices(); })
      .catch(function () { $("#vp-mic-note").textContent = "The microphone was refused. Allow it for this site, then reload."; });
  });

  function meter(level) { var el = $("#vp-level"); if (el) el.style.width = Math.min(100, Math.round(Math.sqrt(level) * 260)) + "%"; }
  function start(id) {
    if (!AC || !window.AudioWorkletNode || !navigator.mediaDevices) { state(id, "this browser cannot record here", "bad"); return; }
    var btn = $('[data-rec="' + id + '"]'), row = btn.closest(".vp-row");
    var a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if ($("#vp-device").value) a.deviceId = { exact: $("#vp-device").value };
    btn.disabled = true;
    navigator.mediaDevices.getUserMedia({ audio: a }).then(function (stream) {
      var ctx = new AC();
      return ctx.audioWorklet.addModule(WORKLET).then(function () {
        var node = new AudioWorkletNode(ctx, "joya-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
        rec = { id: id, ctx: ctx, stream: stream, frames: [] };
        node.port.onmessage = function (e) { if (rec && e.data && e.data.type === "frame") { rec.frames.push(new Int16Array(e.data.pcm)); meter(e.data.level); } };
        ctx.createMediaStreamSource(stream).connect(node);
        rec.timer = setTimeout(function () { if (rec && rec.id === id) stop(); }, 40000);
        btn.disabled = false; btn.textContent = "Stop"; btn.classList.add("primary"); row.classList.add("on");
        state(id, "recording… read it, then Stop", "ok");
        listDevices();
      });
    }).catch(function () { btn.disabled = false; state(id, "the microphone was refused", "bad"); });
  }
  function stop() {
    var r = rec;
    rec = null;
    if (!r) return;
    clearTimeout(r.timer);
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    meter(0);
    var btn = $('[data-rec="' + r.id + '"]'), row = btn.closest(".vp-row");
    btn.textContent = "Record again"; btn.classList.remove("primary"); row.classList.remove("on");
    var n = r.frames.reduce(function (a, f) { return a + f.length; }, 0), all = new Int16Array(n), at = 0;
    r.frames.forEach(function (f) { all.set(f, at); at += f.length; });
    state(r.id, "learning…");
    fetch("/joya-ai/api/voiceprint/enrol-clip?person=" + encodeURIComponent(PERSON) + "&mic=" + encodeURIComponent(slot()) + "&id=" + encodeURIComponent(r.id), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "audio/wav", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: wav(all),
    }).then(json).then(function (j) {
      state(r.id, "done · " + j.speech_s + " s of speech", "ok");
      total(j.total_s);
      var next = row.nextElementSibling && $("[data-rec]", row.nextElementSibling);
      if (next) next.focus(); else if (!$("#vpe-save").disabled) $("#vpe-save").focus();
    }).catch(function (e) { state(r.id, e.message, "bad"); });
  }
  root.addEventListener("click", function (e) {
    var b = e.target.closest("[data-rec]");
    if (!b) return;
    var id = b.getAttribute("data-rec");
    if (rec && rec.id === id) return stop();
    if (rec) stop();
    start(id);
  });
  $("#vpe-save").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    $("#vpe-done").textContent = "Saving…";
    fetch("/joya-ai/api/voiceprint/enrol-save", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF }, body: JSON.stringify({ person: PERSON, mic: slot() }) })
      .then(json)
      .then(function (j) {
        $("#vpe-done").innerHTML = "";
        var t = document.createTextNode("Saved: " + j.name + "'s voiceprint now covers " + j.mics.length + " microphone" + (j.mics.length === 1 ? "" : "s") + ". ");
        var a = document.createElement("a");
        a.href = "/joya-ai/settings/voice#v-vp-people";
        a.textContent = "Back to Settings ▸ Voice";
        $("#vpe-done").appendChild(t);
        $("#vpe-done").appendChild(a);
      })
      .catch(function (e) { btn.disabled = false; $("#vpe-done").textContent = e.message; });
  });
  function refresh() {
    $$(".vp-row").forEach(function (row) { state(row.getAttribute("data-id"), "not recorded"); $("[data-rec]", row).textContent = "Record"; });
    fetch("/joya-ai/api/voiceprint/enrol-status?person=" + encodeURIComponent(PERSON) + "&mic=" + encodeURIComponent(slot()), { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(json)
      .then(function (j) {
        (j.clips || []).forEach(function (id) { state(id, "done", "ok"); var b = $('[data-rec="' + id + '"]'); if (b) b.textContent = "Record again"; });
        total(Math.round((j.total_ms || 0) / 100) / 10);
      })
      .catch(function () { total(0); });
  }
  $("#vp-slot").addEventListener("change", function () { if (rec) stop(); refresh(); });
  window.addEventListener("pagehide", function () { if (rec) rec.stream.getTracks().forEach(function (t) { t.stop(); }); });
  listDevices();
  refresh();
})();
