/* JOYA Library -- view counting. Loaded by the watch page and the embed.
   It reports how much of the video this visit has really played (seconds of video that went by
   while playing, not seeks) to POST /api/beat. The server decides when that becomes a view
   (30 s or half the video, whichever comes first; one per device per video in 30 minutes) and
   counts unique viewers by a random device id kept in this browser (localStorage + a first-party
   cookie). Nothing else is sent: no IP is stored, no third party is involved. */
(function () {
  'use strict';
  var body = document.body;
  var key = body.getAttribute('data-stat-key');
  var src = body.getAttribute('data-stat-src') || 'page';
  var video = document.querySelector('.mlp video');
  if (!key || !video || !window.fetch) return;

  function hex(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([0-9a-f]{32})'));
    return m ? m[1] : null;
  }
  var did = null;
  try { did = window.localStorage.getItem('joyalib:did'); } catch (e) {}
  if (!/^[0-9a-f]{32}$/.test(did || '')) did = readCookie('mlid');
  if (!/^[0-9a-f]{32}$/.test(did || '')) did = hex(16);
  try { window.localStorage.setItem('joyalib:did', did); } catch (e) {}
  try { document.cookie = 'mlid=' + did + '; Max-Age=63072000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) {}
  // Storage blocked entirely (private modes): the server falls back to a keyed hash of IP + browser.
  var stored = false;
  try { stored = window.localStorage.getItem('joyalib:did') === did || readCookie('mlid') === did; } catch (e) {}

  var pid = hex(8);
  var ref = '';
  try {
    if (document.referrer) {
      var r = new URL(document.referrer);
      if (r.host !== location.host || src === 'embed') ref = r.host;
      else ref = 'self';
    }
  } catch (e) {}

  var watched = 0, maxPos = 0, last = null, started = false, sentW = -1, counted = false, timer = null;
  function threshold() {
    var d = video.duration;
    return isFinite(d) && d > 0 ? Math.min(30, d / 2) : 30;
  }
  function payload() {
    return JSON.stringify({ k: key, pid: pid, did: stored ? did : null, w: Math.round(watched * 10) / 10,
      p: Math.round(maxPos * 10) / 10, src: src, ref: ref });
  }
  function send(final) {
    if (!started) return;
    if (!final && Math.abs(watched - sentW) < 0.5 && sentW >= 0) return;
    sentW = watched;
    var data = payload();
    if (final && navigator.sendBeacon) {
      try { if (navigator.sendBeacon('/api/beat', new Blob([data], { type: 'text/plain' }))) return; } catch (e) {}
    }
    fetch('/api/beat', { method: 'POST', body: data, keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'text/plain' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        if (j.counted) counted = true;
        if (window.JoyaCounts && j.views != null) window.JoyaCounts(key, { v: j.views, u: j.uniques });
      }).catch(function () {});
  }

  video.addEventListener('playing', function () {
    last = video.currentTime;
    if (!started) { started = true; send(false); }
    clearInterval(timer);
    timer = setInterval(function () { send(false); }, 15000);
  });
  video.addEventListener('timeupdate', function () {
    var t = video.currentTime;
    if (video.paused || video.seeking || last == null) { last = t; return; }
    var dt = t - last;
    var rate = video.playbackRate || 1;
    // Only time that really went by while playing counts (a seek or a quality swap does not).
    if (dt > 0 && dt <= 1.5 * rate + 0.75) {
      var before = watched;
      watched += dt;
      if (!counted && before < threshold() && watched >= threshold()) send(false);
    }
    last = t;
    if (t > maxPos) maxPos = t;
  });
  video.addEventListener('seeking', function () { last = null; });
  video.addEventListener('seeked', function () { last = video.currentTime; });
  video.addEventListener('pause', function () { clearInterval(timer); send(false); });
  video.addEventListener('ended', function () { clearInterval(timer); send(false); });
  window.addEventListener('pagehide', function () { send(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(true); });
})();
