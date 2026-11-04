/* JOYA Library player -- one file, vanilla JS, no requests other than the video's own files.
   Markup it upgrades (written by library/build.py):
     <div class="mlp" data-mlp='{"id","title","duration","poster","sources":[{h,w,src,bytes}],
                                "thumbs": "thumbs.vtt"|null, "captions":[{src,lang,label}]}'>
       <video class="mlp-video" controls playsinline preload="metadata" poster=…><source …><track …></video>
     </div>
   Without JS the browser's own controls stay. */
(function () {
  'use strict';

  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var IDLE_MS = 2500;
  var store = {
    get: function (k, d) { try { var v = window.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICON = {
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>',
    replay: '<path d="M12 5a7 7 0 1 1-6.6 9.3l1.9-.6A5 5 0 1 0 12 7v3L7.5 6 12 2z"/>',
    vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15 8.5a4.5 4.5 0 0 1 0 7M17.5 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    volLow: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15 8.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    gear: '<path fill-rule="evenodd" d="M10.3 2.5h3.4l.5 2.6a7.5 7.5 0 0 1 1.9 1.1l2.5-.9 1.7 2.9-2 1.7a7.6 7.6 0 0 1 0 2.2l2 1.7-1.7 2.9-2.5-.9a7.5 7.5 0 0 1-1.9 1.1l-.5 2.6h-3.4l-.5-2.6a7.5 7.5 0 0 1-1.9-1.1l-2.5.9-1.7-2.9 2-1.7a7.6 7.6 0 0 1 0-2.2l-2-1.7 1.7-2.9 2.5.9a7.5 7.5 0 0 1 1.9-1.1zM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/>',
    pip: '<rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11.5" width="7" height="5.5" rx="1"/>',
    fs: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>',
    fsExit: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>',
    back: '<path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2"/>',
    next: '<path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
    rew: '<path d="M12 5a7 7 0 1 1-7 7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 1.5v7L8 5z"/>',
    fwd: '<path d="M12 5a7 7 0 1 0 7 7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 1.5v7l4-3.5z"/>',
    theater: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    theaterOff: '<rect x="5" y="7.5" width="14" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    skipNext: '<path d="M6 6l9 6-9 6z"/><path d="M17 6h2v12h-2z"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="currentColor">' + ICON[name] + '</svg>';
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function btn(cls, label, icon) {
    var b = el('button', 'mlp-btn ' + cls, svg(icon));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    return b;
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtWords(t) {
    t = Math.floor(Math.max(0, t || 0));
    var m = Math.floor(t / 60), s = t % 60;
    return (m ? m + (m === 1 ? ' minute ' : ' minutes ') : '') + s + (s === 1 ? ' second' : ' seconds');
  }
  function speedName(r) { return r === 1 ? 'Normal' : r + '×'; }
  function parseTime(s) {
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    var p = s.split(':').map(Number);
    if (p.every(isFinite) && p.length <= 3) return p.reduce(function (a, b) { return a * 60 + b; }, 0);
    return null;
  }
  function vttTime(s) {
    var p = s.trim().split(':'), sec = 0;
    for (var i = 0; i < p.length; i++) sec = sec * 60 + parseFloat(p[i]);
    return sec;
  }
  function parseThumbs(text, base) {
    var cues = [];
    var blocks = text.replace(/\r/g, '').split(/\n\n+/);
    blocks.forEach(function (b) {
      var lines = b.split('\n');
      var i = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
      if (i < 0 || !lines[i + 1]) return;
      var tt = lines[i].split('-->');
      var ref = lines[i + 1].trim();
      var m = /#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(ref);
      if (!m) return;
      cues.push({ s: vttTime(tt[0]), e: vttTime(tt[1]), url: new URL(ref.replace(/#.*$/, ''), base).href,
        x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
    });
    return cues;
  }

  function Player(root) {
    var cfg;
    try { cfg = JSON.parse(root.getAttribute('data-mlp')); } catch (e) { return; }
    if (!cfg || !cfg.sources || !cfg.sources.length) return;
    this.root = root;
    this.cfg = cfg;
    this.sources = cfg.sources.slice().sort(function (a, b) { return b.h - a.h; });
    this.video = root.querySelector('video');
    this.keyPos = 'joyalib:pos:' + cfg.id;
    this.qPref = store.get('joyalib:quality', 'auto');
    if (this.qPref !== 'auto' && !this.sources.some(function (s) { return s.h === this.qPref; }, this)) this.qPref = 'auto';
    this.capH = Infinity;
    this.stalls = [];
    this.cur = null;
    this.switching = false;
    this.started = false;
    this.showRemaining = false;
    this.ccOn = !!store.get('joyalib:cc', false);
    this.thumbs = [];
    this.build();
    this.bind();
    this.initMedia();
  }

  Player.prototype.build = function () {
    var r = this.root, v = this.video, cfg = this.cfg;
    r.classList.add('mlp-ready', 'mlp-paused', 'mlp-fresh');
    r.setAttribute('role', 'region');
    r.setAttribute('aria-label', 'Video player: ' + cfg.title);
    v.removeAttribute('controls');
    v.setAttribute('tabindex', '-1');
    Array.prototype.slice.call(v.querySelectorAll('source, track')).forEach(function (n) { n.remove(); });
    v.disableRemotePlayback = false;

    this.freeze = el('canvas', 'mlp-freeze'); this.freeze.setAttribute('aria-hidden', 'true');
    this.capBox = el('div', 'mlp-captions'); this.capBox.setAttribute('aria-hidden', 'true');
    this.hit = el('div', 'mlp-hit'); this.hit.setAttribute('aria-hidden', 'true');

    this.center = el('div', 'mlp-center');
    this.big = el('button', 'mlp-big', svg('play') + '<span class="mlp-big-label">Play</span>');
    this.big.type = 'button';
    this.big.setAttribute('aria-label', 'Play ' + cfg.title);
    this.startOver = el('button', 'mlp-chip', 'Start from the beginning');
    this.startOver.type = 'button';
    this.startOver.hidden = true;
    this.center.appendChild(this.big);
    this.center.appendChild(this.startOver);

    this.spinner = el('div', 'mlp-spinner', '<span></span>'); this.spinner.setAttribute('aria-hidden', 'true');
    this.fxL = el('div', 'mlp-fx mlp-fx-l', svg('rew') + '<span>10 s</span>'); this.fxL.setAttribute('aria-hidden', 'true');
    this.fxR = el('div', 'mlp-fx mlp-fx-r', svg('fwd') + '<span>10 s</span>'); this.fxR.setAttribute('aria-hidden', 'true');
    this.toast = el('div', 'mlp-toast'); this.toast.setAttribute('aria-hidden', 'true');

    this.errBox = el('div', 'mlp-panel mlp-error',
      '<p class="mlp-panel-title"><span aria-hidden="true">▲ </span><span class="mlp-err-text">The video could not be played.</span></p>');
    this.retry = el('button', 'mlp-chip mlp-chip-solid', 'Try again'); this.retry.type = 'button';
    this.errBox.appendChild(this.retry);
    this.errBox.hidden = true;
    this.endBox = el('div', 'mlp-panel mlp-end', '<p class="mlp-panel-title"><span aria-hidden="true">■ </span>Finished</p>');
    this.replay = el('button', 'mlp-chip mlp-chip-solid', svg('replay') + '<span>Replay</span>'); this.replay.type = 'button';
    this.endBox.appendChild(this.replay);
    this.endBox.hidden = true;
    // Up next (the watch page hands it over with setNext); shown in the end panel.
    this.nextBox = el('div', 'mlp-next');
    this.nextBox.hidden = true;
    this.endBox.appendChild(this.nextBox);

    // Controls
    this.ctrl = el('div', 'mlp-controls');
    this.seek = el('div', 'mlp-seek');
    this.seek.setAttribute('role', 'slider');
    this.seek.setAttribute('tabindex', '0');
    this.seek.setAttribute('aria-label', 'Seek');
    this.seek.setAttribute('aria-valuemin', '0');
    this.rail = el('div', 'mlp-rail');
    this.bufWrap = el('div', 'mlp-buffers');
    this.played = el('div', 'mlp-played');
    this.hoverBar = el('div', 'mlp-hoverbar');
    this.knob = el('div', 'mlp-knob');
    this.rail.appendChild(this.bufWrap); this.rail.appendChild(this.hoverBar); this.rail.appendChild(this.played); this.rail.appendChild(this.knob);
    this.seek.appendChild(this.rail);
    this.preview = el('div', 'mlp-preview', '<div class="mlp-preview-img"></div><div class="mlp-preview-time"></div>');
    this.preview.setAttribute('aria-hidden', 'true');
    this.previewImg = this.preview.firstChild;
    this.previewTime = this.preview.lastChild;
    this.seek.appendChild(this.preview);

    var bar = el('div', 'mlp-bar');
    var left = el('div', 'mlp-left'), right = el('div', 'mlp-right');
    this.bPlay = btn('mlp-play', 'Play (k)', 'play');
    this.bMute = btn('mlp-mute', 'Mute (m)', 'vol');
    this.vol = el('input', 'mlp-vol');
    this.vol.type = 'range'; this.vol.min = '0'; this.vol.max = '1'; this.vol.step = '0.05';
    this.vol.setAttribute('aria-label', 'Volume');
    var volWrap = el('div', 'mlp-volwrap'); volWrap.appendChild(this.bMute); volWrap.appendChild(this.vol);
    this.bTime = el('button', 'mlp-time'); this.bTime.type = 'button';
    left.appendChild(this.bPlay); left.appendChild(volWrap); left.appendChild(this.bTime);

    this.bCC = btn('mlp-cc', 'Captions (c)', 'cc'); this.bCC.setAttribute('aria-pressed', 'false'); this.bCC.hidden = true;
    this.bSet = btn('mlp-set', 'Settings', 'gear');
    this.bSet.setAttribute('aria-haspopup', 'menu'); this.bSet.setAttribute('aria-expanded', 'false');
    this.bPip = btn('mlp-pip', 'Picture in picture (i)', 'pip');
    this.bFs = btn('mlp-fs', 'Full screen (f)', 'fs');
    this.bTheater = btn('mlp-theater', 'Theater mode (t)', 'theater');
    this.bTheater.setAttribute('aria-pressed', 'false');
    this.bTheater.hidden = !cfg.theater;
    this.qBadge = el('span', 'mlp-qbadge'); this.qBadge.setAttribute('aria-hidden', 'true');
    this.bSet.appendChild(this.qBadge);
    right.appendChild(this.bCC); right.appendChild(this.bSet); right.appendChild(this.bPip); right.appendChild(this.bTheater); right.appendChild(this.bFs);
    bar.appendChild(left); bar.appendChild(right);
    this.ctrl.appendChild(this.seek); this.ctrl.appendChild(bar);

    this.menu = el('div', 'mlp-menu');
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'Settings');
    this.menu.id = 'mlp-menu-' + cfg.id;
    this.menu.hidden = true;
    this.bSet.setAttribute('aria-controls', this.menu.id);

    this.help = el('div', 'mlp-help');
    this.help.setAttribute('role', 'dialog');
    this.help.setAttribute('aria-label', 'Keyboard shortcuts');
    this.help.hidden = true;
    var rows = [['Space or K', 'Play or pause'], ['J / L', 'Back / forward 10 seconds'], ['← / →', 'Back / forward 5 seconds'],
      ['↑ / ↓', 'Volume up / down'], ['M', 'Mute'], ['F', 'Full screen'], ['C', 'Captions'], ['I', 'Picture in picture'],
      ['0 – 9', 'Jump to 0 – 90 %'], ['< / >', 'Slower / faster'], ['?', 'Show these shortcuts'], ['Esc', 'Close']];
    if (cfg.theater) rows.splice(7, 0, ['T', 'Theater mode'], ['Shift + N', 'Next video']);
    this.help.innerHTML = '<div class="mlp-help-head"><h2 class="mlp-help-title">Keyboard shortcuts</h2></div><dl>' +
      rows.map(function (x) { return '<div><dt><kbd>' + x[0] + '</kbd></dt><dd>' + x[1] + '</dd></div>'; }).join('') + '</dl>';
    this.helpClose = el('button', 'mlp-chip mlp-chip-solid', 'Close'); this.helpClose.type = 'button';
    this.help.firstChild.appendChild(this.helpClose);

    this.live = el('div', 'mlp-sr'); this.live.setAttribute('aria-live', 'polite'); this.live.setAttribute('role', 'status');

    [this.freeze, this.capBox, this.hit, this.spinner, this.fxL, this.fxR, this.toast, this.center, this.errBox, this.endBox,
      this.ctrl, this.menu, this.help, this.live].forEach(function (n) { r.appendChild(n); });

    var pipOk = (document.pictureInPictureEnabled && !v.disablePictureInPicture) ||
      (typeof v.webkitSetPresentationMode === 'function' && v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture'));
    this.bPip.hidden = !pipOk;
    var fsOk = r.requestFullscreen || r.webkitRequestFullscreen || v.webkitEnterFullscreen;
    this.bFs.hidden = !fsOk;
  };

  Player.prototype.bind = function () {
    var self = this, v = this.video, r = this.root;
    var on = function (t, ev, fn, o) { t.addEventListener(ev, fn, o || false); };

    on(v, 'play', function () { self.sync(); self.hideEnd(); });
    on(v, 'playing', function () { self.loading(false); self.sync(); });
    on(v, 'pause', function () { if (!self.switching) { self.savePos(); self.sync(); } });
    on(v, 'waiting', function () { self.loading(true); self.onStall(); });
    on(v, 'seeking', function () { if (!self.switching) self.loading(true, 250); });
    on(v, 'seeked', function () { if (!self.switching) self.loading(false); self.updateTime(); });
    on(v, 'canplay', function () { if (!self.switching) self.loading(false); });
    on(v, 'timeupdate', function () { self.updateTime(); self.maybeSave(); });
    on(v, 'progress', function () { self.updateBuffer(); });
    on(v, 'durationchange', function () { self.updateTime(); });
    on(v, 'loadedmetadata', function () { self.updateTime(); self.updateBuffer(); });
    on(v, 'volumechange', function () { self.syncVolume(); });
    on(v, 'ratechange', function () { if (!self.switching) self.renderMenu(); });
    on(v, 'ended', function () { self.onEnded(); });
    on(v, 'error', function () { self.onError(); });
    on(v, 'enterpictureinpicture', function () { self.sync(); });
    on(v, 'leavepictureinpicture', function () { self.sync(); });
    on(v, 'webkitbeginfullscreen', function () { self.nativeFs(true); });
    on(v, 'webkitendfullscreen', function () { self.nativeFs(false); });

    on(this.big, 'click', function () { self.play(true); });
    on(this.startOver, 'click', function () { self.resumeAt = null; self.seekTo(0); self.play(false); });
    on(this.bPlay, 'click', function () { self.toggle(); });
    on(this.retry, 'click', function () { self.retryLoad(); });
    on(this.replay, 'click', function () { self.seekTo(0); self.play(false); });
    on(this.bMute, 'click', function () { self.toggleMute(); });
    on(this.vol, 'input', function () {
      var x = parseFloat(self.vol.value);
      v.volume = x; v.muted = x === 0;
    });
    on(this.bTime, 'click', function () { self.showRemaining = !self.showRemaining; self.updateTime(); });
    on(this.bCC, 'click', function () { self.setCC(!self.ccOn, true); });
    on(this.bPip, 'click', function () { self.togglePip(); });
    on(this.bFs, 'click', function () { self.toggleFs(); });
    on(this.bTheater, 'click', function () { self.requestTheater(); });
    on(this.bSet, 'click', function () { self.menu.hidden ? self.openMenu('main', false) : self.closeMenu(false); });
    on(this.bSet, 'keydown', function (e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && self.menu.hidden) { e.preventDefault(); self.openMenu('main', true); }
    });
    on(this.menu, 'keydown', function (e) { self.menuKey(e); });
    on(this.helpClose, 'click', function () { self.toggleHelp(false); });
    on(document, 'pointerdown', function (e) {
      if (!self.menu.hidden && !self.menu.contains(e.target) && !self.bSet.contains(e.target)) self.closeMenu(false);
    }, true);

    // Pointer on the picture: click/tap = play/pause, double = full screen; touch double-tap sides = skip.
    var lastTouch = 0, tapTimer = null, taps = 0, tapZone = null;
    on(this.hit, 'click', function (e) {
      if (Date.now() - lastTouch < 700) return;
      if (e.detail > 1) return;
      if (!self.started) { self.play(true); return; }
      self.toggle();
    });
    on(this.hit, 'dblclick', function () {
      if (Date.now() - lastTouch < 700) return;
      self.toggle();
      self.toggleFs();
    });
    on(this.hit, 'pointerup', function (e) {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      lastTouch = Date.now();
      var rect = self.root.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width;
      var zone = x < 1 / 3 ? 'l' : x > 2 / 3 ? 'r' : 'c';
      if (tapTimer && zone === tapZone) {
        clearTimeout(tapTimer); tapTimer = null;
        taps++;
        if (zone === 'c') { if (taps === 2) self.toggleFs(); taps = 0; return; }
        self.skip(zone === 'l' ? -10 : 10, true);
        tapTimer = setTimeout(function () { tapTimer = null; taps = 0; }, 450);
        return;
      }
      taps = 1; tapZone = zone;
      tapTimer = setTimeout(function () {
        tapTimer = null; taps = 0;
        if (!self.started) { self.play(true); return; }
        if (r.classList.contains('mlp-idle')) { self.showControls(); return; }
        self.toggle();
      }, 300);
    });

    // Seek bar
    this.bindSeek();

    // Auto-hide
    on(r, 'pointermove', function (e) { if (e.pointerType === 'mouse') self.showControls(); });
    on(r, 'pointerdown', function (e) { r.classList.toggle('mlp-touch', e.pointerType === 'touch' || e.pointerType === 'pen'); }, true);
    on(r, 'pointerleave', function (e) { if (e.pointerType === 'mouse' && !self.video.paused) self.hideSoon(600); });
    on(r, 'focusin', function () { self.showControls(); });
    on(r, 'focusout', function () { self.hideSoon(); });

    // Keyboard
    on(document, 'keydown', function (e) { self.onKey(e); });

    // Full screen + size
    var fsChange = function () { self.sync(); self.autoRecheck(); };
    on(document, 'fullscreenchange', fsChange);
    on(document, 'webkitfullscreenchange', fsChange);
    if (window.ResizeObserver) {
      var t;
      new ResizeObserver(function () {
        r.classList.toggle('mlp-compact', r.clientWidth < 560);
        r.classList.toggle('mlp-tiny', r.clientWidth < 380);
        clearTimeout(t); t = setTimeout(function () { self.autoRecheck(); }, 700);
      }).observe(r);
    }
    var conn = navigator.connection;
    if (conn && conn.addEventListener) conn.addEventListener('change', function () { self.autoRecheck(); });

    on(window, 'pagehide', function () { self.savePos(); });
    on(document, 'visibilitychange', function () { if (document.visibilityState === 'hidden') self.savePos(); });
  };

  Player.prototype.initMedia = function () {
    var self = this, v = this.video, cfg = this.cfg;
    v.volume = clamp(store.get('joyalib:volume', 1), 0, 1);
    v.muted = !!store.get('joyalib:muted', false);
    var rate = store.get('joyalib:speed', 1);
    if (SPEEDS.indexOf(rate) === -1) rate = 1;
    v.defaultPlaybackRate = rate; v.playbackRate = rate;
    this.pick(false);

    // Start time: ?t= / #t= in the address, else the stored position.
    var url = new URL(location.href);
    var t = parseTime(url.searchParams.get('t') || (/(?:^|&)t=([^&]+)/.exec(location.hash.slice(1)) || [])[1]);
    var pos = store.get(this.keyPos, null);
    if (url.searchParams.get('autoplay') === '1') {
      // Arrived from Up next: start at once when the browser allows it, else the Play button stays.
      url.searchParams.delete('autoplay');
      try { history.replaceState(history.state, '', url.pathname + url.search + url.hash); } catch (e) {}
      this.autoStart = true;
    }
    if (t != null && t > 0) { this.startAt = t; }
    else if (pos && pos.t > 10 && pos.t < (cfg.duration || 1e9) - 10) {
      this.resumeAt = pos.t;
      this.big.querySelector('.mlp-big-label').textContent = 'Resume from ' + fmt(pos.t);
      this.big.setAttribute('aria-label', 'Resume ' + cfg.title + ' from ' + fmtWords(pos.t));
      this.startOver.hidden = false;
    }

    // Captions: fetched and handed to the track as a blob, so the server's content type does not matter.
    if (cfg.captions && cfg.captions.length) {
      this.bCC.hidden = false;
      var c = cfg.captions[0];
      fetch(c.src).then(function (res) { if (!res.ok) throw new Error(res.status); return res.text(); }).then(function (text) {
        var tr = document.createElement('track');
        tr.kind = 'captions'; tr.srclang = c.lang; tr.label = c.label;
        tr.src = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
        v.appendChild(tr);
        self.track = tr.track;
        self.track.mode = 'hidden';
        self.track.addEventListener('cuechange', function () { self.renderCue(); });
        self.setCC(self.ccOn, false);
      }).catch(function () { self.bCC.hidden = true; self.cfg.captions = []; self.renderMenu(); });
    }
    if (cfg.thumbs) {
      fetch(cfg.thumbs).then(function (res) { if (!res.ok) throw new Error(res.status); return res.text(); }).then(function (text) {
        self.thumbs = parseThumbs(text, new URL(cfg.thumbs, location.href).href);
        if (self.thumbs[0]) { var img = new Image(); img.src = self.thumbs[0].url; }
      }).catch(function () {});
    }
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: cfg.title, artist: 'JOYA Library',
          artwork: [{ src: new URL(cfg.poster, location.href).href, sizes: '1280x720', type: 'image/jpeg' }] });
        navigator.mediaSession.setActionHandler('seekbackward', function () { self.skip(-10); });
        navigator.mediaSession.setActionHandler('seekforward', function () { self.skip(10); });
      } catch (e) {}
    }
    this.syncVolume();
    this.renderMenu();
    this.updateTime();
    this.sync();
    if (this.autoStart) {
      var vv = v;
      var p = vv.play();
      if (p && p.then) p.then(function () {
        if (!self.started) { self.started = true; self.root.classList.remove('mlp-fresh'); self.startOver.hidden = true; }
        if (self.startAt) { self.seekTo(self.startAt); self.startAt = null; }
        self.sync();
      }, function () { self.sync(); });
    }
  };

  /* ---------------- quality ---------------- */
  Player.prototype.autoChoice = function () {
    var list = this.sources;
    var lowest = list[list.length - 1];
    var need = Math.max(320, this.root.clientWidth || 640) * Math.min(window.devicePixelRatio || 1, 2);
    var pick = list[0];
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].w >= need * 0.9) { pick = list[i]; break; } }
    var cap = this.capH;
    var c = navigator.connection;
    if (c) {
      if (c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g') cap = Math.min(cap, lowest.h);
      else if (c.effectiveType === '3g') cap = Math.min(cap, 480);
      if (c.downlink && c.downlink < 1.6) cap = Math.min(cap, 480);
      else if (c.downlink && c.downlink < 3.5) cap = Math.min(cap, 720);
    }
    if (pick.h > cap) {
      pick = list.filter(function (s) { return s.h <= cap; })[0] || lowest;
    }
    return pick;
  };
  Player.prototype.pick = function (announce) {
    var self = this;
    var target = this.qPref === 'auto' ? this.autoChoice() : this.sources.filter(function (s) { return s.h === self.qPref; })[0];
    if (!target) target = this.autoChoice();
    if (this.cur && target.src === this.cur.src) { this.renderMenu(); if (announce) this.say('Quality ' + this.qualityName()); return; }
    this.switchTo(target, announce);
  };
  Player.prototype.qualityName = function () {
    var h = this.cur ? this.cur.h + 'p' : '';
    return this.qPref === 'auto' ? 'Auto' + (h ? ' (' + h + ')' : '') : h;
  };
  Player.prototype.setQuality = function (pref) {
    this.qPref = pref;
    if (pref === 'auto') this.capH = Infinity;
    store.set('joyalib:quality', pref);
    this.pick(true);
  };
  Player.prototype.autoRecheck = function () {
    if (this.qPref !== 'auto' || this.switching || !this.cur) return;
    var t = this.autoChoice();
    if (t.src !== this.cur.src) this.switchTo(t, true);
  };
  Player.prototype.onStall = function () {
    if (this.switching || this.video.seeking || !this.started || this.video.currentTime < 1) return;
    var now = Date.now();
    this.stalls = this.stalls.filter(function (t) { return now - t < 30000; });
    this.stalls.push(now);
    if (this.qPref === 'auto' && this.stalls.length >= 3 && this.cur) {
      var lower = this.sources.filter(function (s) { return s.h < this.cur.h; }, this)[0];
      if (lower) {
        this.capH = lower.h;
        this.stalls = [];
        this.switchTo(lower, true, 'Playback kept stopping. Quality lowered to ' + lower.h + 'p');
      }
    }
  };
  // Swap renditions on the same <video>: the new file is warmed in a hidden element first, the current frame is
  // held on a canvas during the swap, and the position, play/pause state and speed carry over.
  Player.prototype.switchTo = function (target, announce, message) {
    var self = this, v = this.video;
    if (!this.cur || (v.readyState < 1 && !this.started)) {
      this.cur = target;
      v.src = target.src;
      this.renderMenu();
      return;
    }
    var token = (this.swapToken = (this.swapToken || 0) + 1);
    var warm = document.createElement('video');
    warm.muted = true; warm.preload = 'auto'; warm.playsInline = true;
    var go = function () {
      if (token !== self.swapToken) return;
      warm.removeAttribute('src'); try { warm.load(); } catch (e) {}
      self.swap(target, announce, message);
    };
    var timer = setTimeout(go, 3000);
    warm.addEventListener('loadedmetadata', function () { try { warm.currentTime = v.currentTime + 1; } catch (e) {} });
    warm.addEventListener('canplay', function () { clearTimeout(timer); go(); }, { once: true });
    warm.addEventListener('error', function () { clearTimeout(timer); go(); }, { once: true });
    warm.src = target.src;
    this.pendingQ = target;
    this.renderMenu();
  };
  Player.prototype.swap = function (target, announce, message) {
    var self = this, v = this.video;
    var t = v.currentTime, wasPlaying = !v.paused && !v.ended, rate = v.playbackRate;
    this.holdFrame();
    this.switching = true;
    this.switchState = { t: t, playing: wasPlaying };
    this.cur = target;
    this.pendingQ = null;
    var done = false;
    var finish = function () {
      if (done) return; done = true;
      self.switching = false;
      self.releaseFrame();
      self.loading(false);
      v.playbackRate = rate;
      if (wasPlaying) { var p = v.play(); if (p && p.catch) p.catch(function () { self.sync(); }); }
      self.sync(); self.updateTime(); self.updateBuffer(); self.renderMenu();
      if (announce) self.say(message || ('Quality ' + self.qualityName()), target.h + 'p');
    };
    v.addEventListener('loadedmetadata', function meta() {
      v.removeEventListener('loadedmetadata', meta);
      v.playbackRate = rate;
      try { v.currentTime = t; } catch (e) {}
      if (Math.abs(v.currentTime - t) < 0.05 && v.readyState >= 2) finish();
    });
    v.addEventListener('seeked', function sk() { v.removeEventListener('seeked', sk); finish(); });
    setTimeout(function () { if (!done) { self.loading(true); } }, 400);
    setTimeout(finish, 15000);
    v.src = target.src;
    v.load();
  };
  Player.prototype.holdFrame = function () {
    var v = this.video, c = this.freeze;
    if (!v.videoWidth) return;
    try {
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.classList.add('on');
    } catch (e) {}
  };
  Player.prototype.releaseFrame = function () {
    var c = this.freeze;
    requestAnimationFrame(function () { requestAnimationFrame(function () { c.classList.remove('on'); }); });
  };

  /* ---------------- playback ---------------- */
  Player.prototype.play = function (fromBig) {
    var self = this, v = this.video;
    this.hideError();
    if (!this.started) {
      this.started = true;
      this.root.classList.remove('mlp-fresh');
      var at = this.startAt != null ? this.startAt : (fromBig ? this.resumeAt : null);
      this.startAt = null;
      if (at) this.seekTo(at);
      this.startOver.hidden = true;
    }
    var p = v.play();
    if (p && p.catch) p.catch(function (err) {
      if (err && err.name === 'NotAllowedError') { self.sync(); return; }
      if (err && err.name !== 'AbortError') self.sync();
    });
  };
  Player.prototype.toggle = function () {
    if (this.switching) {
      this.switchState.playing = !this.switchState.playing;
      return this.sync();
    }
    if (this.video.paused || this.video.ended) this.play(true); else this.video.pause();
  };
  Player.prototype.isPlaying = function () {
    return this.switching ? this.switchState.playing : !this.video.paused && !this.video.ended;
  };
  Player.prototype.duration = function () {
    var d = this.video.duration;
    return isFinite(d) && d > 0 ? d : (this.cfg.duration || 0);
  };
  Player.prototype.now = function () { return this.switching ? this.switchState.t : this.video.currentTime; };
  Player.prototype.seekTo = function (t) {
    var v = this.video, d = this.duration();
    t = clamp(t, 0, d ? d - 0.05 : t);
    if (!this.started) { this.startAt = t; this.updateTime(t); return; }
    if (this.switching) { this.switchState.t = t; return; }
    if (v.readyState < 1) {
      v.addEventListener('loadedmetadata', function once() { v.removeEventListener('loadedmetadata', once); v.currentTime = t; });
      if (!v.src) v.src = this.cur.src;
      v.load();
    } else {
      v.currentTime = t;
    }
    if (v.ended || t < d - 0.1) this.hideEnd();
    this.updateTime(t);
  };
  Player.prototype.skip = function (dt, fx) {
    if (!this.started) this.play(false);
    this.seekTo(this.now() + dt);
    var box = dt < 0 ? this.fxL : this.fxR;
    box.querySelector('span').textContent = Math.abs(dt) + ' s';
    box.classList.remove('on'); void box.offsetWidth; box.classList.add('on');
    this.say((dt < 0 ? 'Back ' : 'Forward ') + Math.abs(dt) + ' seconds', null, true);
  };
  Player.prototype.toggleMute = function () {
    var v = this.video;
    if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; }
    else v.muted = true;
    this.say(v.muted ? 'Muted' : 'Sound on, volume ' + Math.round(v.volume * 100) + ' %', v.muted ? 'Muted' : Math.round(v.volume * 100) + ' %');
  };
  Player.prototype.nudgeVolume = function (d) {
    var v = this.video;
    v.volume = clamp(Math.round((v.volume + d) * 20) / 20, 0, 1);
    v.muted = v.volume === 0;
    this.say('Volume ' + Math.round(v.volume * 100) + ' %', Math.round(v.volume * 100) + ' %');
  };
  Player.prototype.setSpeed = function (r) {
    r = clamp(r, 0.5, 2);
    this.video.defaultPlaybackRate = r;
    this.video.playbackRate = r;
    store.set('joyalib:speed', r);
    this.renderMenu();
    this.say('Speed ' + speedName(r), r === 1 ? '1×' : r + '×');
  };
  Player.prototype.stepSpeed = function (dir) {
    var i = SPEEDS.indexOf(this.video.playbackRate);
    if (i === -1) i = 2;
    this.setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
  };
  Player.prototype.setCC = function (on, announce) {
    if (!this.cfg.captions || !this.cfg.captions.length) return;
    this.ccOn = on;
    store.set('joyalib:cc', on);
    this.bCC.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.bCC.setAttribute('aria-label', on ? 'Captions on (c)' : 'Captions off (c)');
    this.root.classList.toggle('mlp-cc-on', on);
    this.renderCue();
    this.renderMenu();
    if (announce) this.say(on ? 'Captions on' : 'Captions off', on ? 'CC on' : 'CC off');
  };
  Player.prototype.renderCue = function () {
    var box = this.capBox;
    box.textContent = '';
    if (!this.ccOn || !this.track || !this.track.activeCues) return;
    Array.prototype.forEach.call(this.track.activeCues, function (cue) {
      var line = el('span', 'mlp-cue');
      line.textContent = String(cue.text || '').replace(/<[^>]*>/g, '');
      box.appendChild(line);
    });
  };
  Player.prototype.nativeFs = function (on) {
    if (this.track) this.track.mode = on && this.ccOn ? 'showing' : 'hidden';
  };
  Player.prototype.fsElement = function () { return document.fullscreenElement || document.webkitFullscreenElement || null; };
  Player.prototype.toggleFs = function () {
    var r = this.root, v = this.video;
    if (this.fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    var p = null;
    try {
      if (r.requestFullscreen) p = r.requestFullscreen({ navigationUI: 'hide' });
      else if (r.webkitRequestFullscreen) p = r.webkitRequestFullscreen();
      else if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return; }
    } catch (e) {
      if (v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch (e2) {} }
      return;
    }
    if (p && p.then) p.then(function () {
      if (screen.orientation && screen.orientation.lock && window.matchMedia('(pointer: coarse)').matches && v.videoWidth > v.videoHeight) {
        screen.orientation.lock('landscape').catch(function () {});
      }
    }).catch(function () { if (v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch (e) {} } });
  };
  Player.prototype.togglePip = function () {
    var v = this.video, self = this;
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else v.requestPictureInPicture().catch(function () { self.say('Picture in picture is not available here'); });
    } else if (typeof v.webkitSetPresentationMode === 'function') {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    }
  };

  /* ---------------- state ---------------- */
  Player.prototype.loading = function (on, delay) {
    var self = this;
    clearTimeout(this.loadTimer);
    if (!on) { this.root.classList.remove('mlp-loading'); return; }
    this.loadTimer = setTimeout(function () {
      if (self.video.paused && !self.switching && !self.video.seeking) return;
      self.root.classList.add('mlp-loading');
    }, delay == null ? 300 : delay);
  };
  Player.prototype.onEnded = function () {
    store.del(this.keyPos);
    store.set('joyalib:seen:' + this.cfg.id, Date.now());
    this.endBox.hidden = false;
    this.root.classList.add('mlp-ended');
    this.sync();
    this.root.dispatchEvent(new CustomEvent('mlp:ended', { bubbles: true }));
    if (this.next) this.showNext(); else this.say('Finished');
  };
  Player.prototype.hideEnd = function () {
    this.endBox.hidden = true; this.root.classList.remove('mlp-ended'); this.cancelNext(true);
  };
  /* Up next: {title, url, poster, duration}. autoplay = count down and go when the video ends. */
  Player.prototype.setNext = function (next, autoplay) {
    this.next = next || null;
    this.autoNext = !!autoplay;
    if (!this.endBox.hidden && this.next) this.showNext();
    if (!this.autoNext) this.cancelNext(false);
  };
  Player.prototype.setAutoNext = function (on) {
    this.autoNext = !!on;
    if (!on) this.cancelNext(false);
  };
  Player.prototype.goNext = function () {
    if (!this.next) return;
    var u = new URL(this.next.url, location.href);
    u.searchParams.set('autoplay', '1');
    location.href = u.pathname + u.search;
  };
  Player.prototype.showNext = function () {
    var self = this, n = this.next, box = this.nextBox;
    box.innerHTML = '';
    var head = el('p', 'mlp-next-label', 'Up next');
    var link = el('a', 'mlp-next-card');
    link.href = n.url;
    link.innerHTML = '<span class="mlp-next-img"><img alt="" src="' + n.poster + '"><span class="mlp-next-dur">' +
      (n.duration || '') + '</span></span><span class="mlp-next-title"></span>';
    link.querySelector('.mlp-next-title').textContent = n.title;
    var row = el('div', 'mlp-next-row');
    this.nextCount = el('p', 'mlp-next-count');
    this.nextCount.setAttribute('aria-live', 'off');
    var play = el('button', 'mlp-chip mlp-chip-solid', svg('skipNext') + '<span>Play now</span>'); play.type = 'button';
    var cancel = el('button', 'mlp-chip', 'Cancel'); cancel.type = 'button';
    play.addEventListener('click', function () { self.goNext(); });
    cancel.addEventListener('click', function () { self.cancelNext(false); self.replay.focus(); });
    this.nextCancel = cancel;
    row.appendChild(play); row.appendChild(cancel);
    box.appendChild(head); box.appendChild(link); box.appendChild(this.nextCount); box.appendChild(row);
    box.hidden = false;
    this.root.classList.add('mlp-has-next');
    if (this.autoNext && !this.isFs()) {
      var left = 8;
      var tick = function () {
        self.nextCount.textContent = 'Playing in ' + left + ' s';
        if (left <= 0) { self.goNext(); return; }
        left--;
        self.nextTimer = setTimeout(tick, 1000);
      };
      tick();
      this.say('Finished. Up next: ' + n.title + ', playing in 8 seconds. Cancel to stay.');
    } else {
      cancel.hidden = true;
      this.say('Finished. Up next: ' + n.title + '.');
    }
  };
  Player.prototype.cancelNext = function (hide) {
    clearTimeout(this.nextTimer); this.nextTimer = null;
    if (this.nextCount) this.nextCount.textContent = '';
    if (this.nextCancel) this.nextCancel.hidden = true;
    if (hide) { this.nextBox.hidden = true; this.root.classList.remove('mlp-has-next'); }
  };
  Player.prototype.isFs = function () { return !!this.fsElement(); };
  /* Theater mode belongs to the page: ask it, and it answers with setTheater. */
  Player.prototype.requestTheater = function () {
    this.root.dispatchEvent(new CustomEvent('mlp:theater', { bubbles: true }));
  };
  Player.prototype.setTheater = function (on) {
    this.bTheater.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.bTheater.setAttribute('aria-label', on ? 'Default view (t)' : 'Theater mode (t)');
    this.bTheater.innerHTML = svg(on ? 'theaterOff' : 'theater');
    this.autoRecheck();
  };
  Player.prototype.onError = function () {
    if (this.switching) { this.switching = false; this.releaseFrame(); }
    var e = this.video.error;
    if (!e) return;
    var text = e.code === 2 ? 'The connection dropped while loading the video.' :
      e.code === 4 ? 'This browser cannot play the video.' : 'The video could not be played.';
    this.errBox.querySelector('.mlp-err-text').textContent = text;
    this.errBox.hidden = false;
    this.root.classList.add('mlp-has-error');
    this.loading(false);
    this.sync();
    this.say(text + ' Try again.');
  };
  Player.prototype.hideError = function () { this.errBox.hidden = true; this.root.classList.remove('mlp-has-error'); };
  Player.prototype.retryLoad = function () {
    var v = this.video, t = this.lastGood || v.currentTime || 0;
    this.hideError();
    this.started = true;
    v.addEventListener('loadedmetadata', function once() {
      v.removeEventListener('loadedmetadata', once);
      try { v.currentTime = t; } catch (e) {}
      v.play().catch(function () {});
    });
    v.src = this.cur.src;
    v.load();
  };
  Player.prototype.maybeSave = function () {
    var t = this.video.currentTime;
    if (!this.switching && t > 0) this.lastGood = t;
    var now = Date.now();
    if (this.started && !this.switching && now - (this.lastSave || 0) > 5000) { this.lastSave = now; this.savePos(); }
  };
  Player.prototype.savePos = function () {
    if (!this.started || this.switching) return;
    var t = this.video.currentTime, d = this.duration();
    if (t > 10 && t < d - 10) store.set(this.keyPos, { t: Math.round(t * 10) / 10, at: Date.now() });
    else if (t >= d - 10) store.del(this.keyPos);
  };
  Player.prototype.syncVolume = function () {
    var v = this.video;
    var level = v.muted ? 0 : v.volume;
    this.vol.value = String(level);
    this.vol.setAttribute('aria-valuetext', v.muted ? 'Muted' : Math.round(v.volume * 100) + ' %');
    this.vol.style.setProperty('--mlp-fill', (level * 100) + '%');
    this.bMute.innerHTML = svg(level === 0 ? 'mute' : level < 0.5 ? 'volLow' : 'vol');
    this.bMute.setAttribute('aria-label', level === 0 ? 'Unmute (m)' : 'Mute (m)');
    store.set('joyalib:volume', v.volume);
    store.set('joyalib:muted', v.muted);
  };
  Player.prototype.sync = function () {
    var playing = this.isPlaying(), r = this.root;
    r.classList.toggle('mlp-playing', playing);
    r.classList.toggle('mlp-paused', !playing);
    this.bPlay.innerHTML = svg(this.video.ended && !playing ? 'replay' : playing ? 'pause' : 'play');
    this.bPlay.setAttribute('aria-label', playing ? 'Pause (k)' : this.video.ended ? 'Replay' : 'Play (k)');
    var fs = !!this.fsElement();
    r.classList.toggle('mlp-fs', fs);
    this.bFs.innerHTML = svg(fs ? 'fsExit' : 'fs');
    this.bFs.setAttribute('aria-label', fs ? 'Exit full screen (f)' : 'Full screen (f)');
    var pip = document.pictureInPictureElement === this.video || this.video.webkitPresentationMode === 'picture-in-picture';
    this.bPip.setAttribute('aria-label', pip ? 'Exit picture in picture (i)' : 'Picture in picture (i)');
    this.bPip.classList.toggle('is-on', pip);
    if (playing) this.hideSoon(); else this.showControls();
  };
  Player.prototype.updateTime = function (forced) {
    var t = forced != null ? forced : (this.started ? this.now() : (this.startAt != null ? this.startAt : 0));
    var d = this.duration();
    var pct = d ? clamp(t / d, 0, 1) * 100 : 0;
    if (!this.scrubbing) {
      this.played.style.width = pct + '%';
      this.knob.style.left = pct + '%';
    }
    this.bTime.textContent = (this.showRemaining ? '−' + fmt(d - t) : fmt(t)) + ' / ' + fmt(d);
    this.bTime.setAttribute('aria-label', (this.showRemaining ? fmtWords(d - t) + ' left' : fmtWords(t) + ' played') +
      ' of ' + fmtWords(d) + '. Show ' + (this.showRemaining ? 'time played' : 'time left'));
    this.seek.setAttribute('aria-valuemax', String(Math.round(d)));
    this.seek.setAttribute('aria-valuenow', String(Math.round(t)));
    this.seek.setAttribute('aria-valuetext', fmtWords(t) + ' of ' + fmtWords(d));
  };
  Player.prototype.updateBuffer = function () {
    var b = this.video.buffered, d = this.duration(), wrap = this.bufWrap;
    if (!d || this.switching) return;
    while (wrap.children.length < b.length) wrap.appendChild(el('div', 'mlp-buffer'));
    while (wrap.children.length > b.length) wrap.removeChild(wrap.lastChild);
    for (var i = 0; i < b.length; i++) {
      var s = b.start(i) / d * 100, e = b.end(i) / d * 100;
      wrap.children[i].style.left = s + '%';
      wrap.children[i].style.width = Math.max(0, e - s) + '%';
    }
  };

  /* ---------------- seek bar ---------------- */
  Player.prototype.bindSeek = function () {
    var self = this, s = this.seek, lastSet = 0;
    var timeAt = function (x) {
      var r = self.rail.getBoundingClientRect();
      return clamp((x - r.left) / r.width, 0, 1) * self.duration();
    };
    var showPreview = function (x) {
      var t = timeAt(x), d = self.duration();
      var r = self.rail.getBoundingClientRect(), sr = s.getBoundingClientRect();
      self.previewTime.textContent = fmt(t);
      var cue = null;
      for (var i = 0; i < self.thumbs.length; i++) { if (t >= self.thumbs[i].s && t < self.thumbs[i].e) { cue = self.thumbs[i]; break; } }
      if (!cue && self.thumbs.length && t >= self.thumbs[self.thumbs.length - 1].s) cue = self.thumbs[self.thumbs.length - 1];
      var img = self.previewImg;
      if (cue) {
        img.style.display = '';
        img.style.width = cue.w + 'px'; img.style.height = cue.h + 'px';
        img.style.backgroundImage = 'url("' + cue.url + '")';
        img.style.backgroundPosition = (-cue.x) + 'px ' + (-cue.y) + 'px';
      } else {
        img.style.display = 'none';
      }
      var w = self.preview.offsetWidth || (cue ? cue.w : 60);
      var left = clamp(x - sr.left - w / 2, r.left - sr.left, r.right - sr.left - w);
      self.preview.style.left = left + 'px';
      self.preview.classList.add('on');
      self.hoverBar.style.width = (d ? t / d * 100 : 0) + '%';
      return t;
    };
    var hidePreview = function () { self.preview.classList.remove('on'); self.hoverBar.style.width = '0'; };
    var paint = function (t) {
      var d = self.duration(), pct = d ? t / d * 100 : 0;
      self.played.style.width = pct + '%'; self.knob.style.left = pct + '%';
    };
    s.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      try { s.setPointerCapture(e.pointerId); } catch (err) {}
      self.scrubbing = true;
      self.root.classList.add('mlp-scrubbing');
      var t = showPreview(e.clientX);
      paint(t);
      self.seekTo(t); lastSet = Date.now();
      s.focus({ preventScroll: true });
    });
    s.addEventListener('pointermove', function (e) {
      var t = showPreview(e.clientX);
      if (self.scrubbing) {
        paint(t);
        if (Date.now() - lastSet > 120) {
          lastSet = Date.now();
          if (self.video.fastSeek && self.started && !self.switching) self.video.fastSeek(t); else self.seekTo(t);
        }
      }
    });
    var end = function (e) {
      if (!self.scrubbing) return;
      self.scrubbing = false;
      self.root.classList.remove('mlp-scrubbing');
      if (e && e.type === 'pointerup') self.seekTo(timeAt(e.clientX));
      if (e && e.pointerType !== 'mouse') hidePreview();
      self.hideSoon();
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('pointerleave', function (e) { if (!self.scrubbing && e.pointerType === 'mouse') hidePreview(); });
    s.addEventListener('keydown', function (e) {
      var d = self.duration(), t = self.now(), n = null;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': n = t - 5; break;
        case 'ArrowRight': case 'ArrowUp': n = t + 5; break;
        case 'PageDown': n = t - 10; break;
        case 'PageUp': n = t + 10; break;
        case 'Home': n = 0; break;
        case 'End': n = d - 0.1; break;
        default: return;
      }
      e.preventDefault(); e.stopPropagation();
      self.seekTo(n);
    });
  };

  /* ---------------- controls visibility ---------------- */
  Player.prototype.showControls = function () {
    this.root.classList.remove('mlp-idle');
    this.hideSoon();
  };
  Player.prototype.hideSoon = function (ms) {
    var self = this;
    clearTimeout(this.idleTimer);
    if (!this.isPlaying()) return;
    this.idleTimer = setTimeout(function () {
      if (!self.isPlaying() || !self.menu.hidden || !self.help.hidden || self.scrubbing) return;
      var a = document.activeElement;
      if (a && self.root.contains(a) && a !== self.video && a.matches && a.matches(':focus-visible')) return;
      self.root.classList.add('mlp-idle');
    }, ms == null ? IDLE_MS : ms);
  };
  Player.prototype.say = function (text, visual, quiet) {
    var live = this.live, toast = this.toast;
    if (!quiet) {
      live.textContent = '';
      setTimeout(function () { live.textContent = text; }, 30);
    }
    if (visual) {
      toast.textContent = visual;
      toast.classList.remove('on'); void toast.offsetWidth; toast.classList.add('on');
    }
  };

  /* ---------------- settings menu ---------------- */
  Player.prototype.renderMenu = function (view) {
    var self = this, m = this.menu;
    this.menuView = view || this.menuView || 'main';
    if (this.cur) this.qBadge.textContent = this.cur.h >= 1080 ? 'HD' : '';
    if (m.hidden && !view) return;
    var v = this.video, items = [];
    m.innerHTML = '';
    var add = function (label, value, opts) {
      var b = el('button', 'mlp-mi' + (opts.cls ? ' ' + opts.cls : ''));
      b.type = 'button';
      b.setAttribute('role', opts.role || 'menuitem');
      if (opts.checked != null) b.setAttribute('aria-checked', opts.checked ? 'true' : 'false');
      if (opts.sub) b.setAttribute('aria-haspopup', 'menu');
      b.innerHTML = (opts.checked != null ? '<span class="mlp-mi-check">' + (opts.checked ? svg('check') : '') + '</span>' : '') +
        (opts.back ? '<span class="mlp-mi-check">' + svg('back') + '</span>' : '') +
        '<span class="mlp-mi-label">' + label + '</span>' +
        (value != null ? '<span class="mlp-mi-value">' + value + '</span>' : '') +
        (opts.sub ? '<span class="mlp-mi-next">' + svg('next') + '</span>' : '');
      b.addEventListener('click', opts.act);
      if (opts.key) b.dataset.key = opts.key;
      m.appendChild(b);
      items.push(b);
      return b;
    };
    var viewName = this.menuView;
    if (viewName === 'main') {
      add('Speed', speedName(v.playbackRate), { sub: true, key: 'speed', act: function () { self.openMenu('speed', true); } });
      add('Quality', this.qualityName() + (this.pendingQ ? ' …' : ''), { sub: true, key: 'quality', act: function () { self.openMenu('quality', true); } });
      if (this.cfg.captions && this.cfg.captions.length) {
        add('Captions', this.ccOn ? this.cfg.captions[0].label : 'Off', { sub: true, key: 'captions', act: function () { self.openMenu('captions', true); } });
      }
      add('Keyboard shortcuts', '?', { key: 'help', act: function () { self.closeMenu(false); self.toggleHelp(true); } });
    } else {
      var title = { speed: 'Speed', quality: 'Quality', captions: 'Captions' }[viewName];
      add(title, null, { back: true, cls: 'mlp-mi-head', act: function () { self.openMenu('main', true, viewName); } });
      if (viewName === 'speed') {
        SPEEDS.forEach(function (r) {
          add(speedName(r), null, { role: 'menuitemradio', checked: v.playbackRate === r, act: function () { self.setSpeed(r); self.openMenu('main', true, 'speed'); } });
        });
      } else if (viewName === 'quality') {
        var autoNow = self.qPref === 'auto' && self.cur ? self.cur.h + 'p' : (self.autoChoice().h + 'p');
        add('Auto', autoNow, { role: 'menuitemradio', checked: self.qPref === 'auto', act: function () { self.setQuality('auto'); self.openMenu('main', true, 'quality'); } });
        self.sources.forEach(function (s) {
          add(s.h + 'p' + (s.h >= 1080 ? ' <span class="mlp-hd">HD</span>' : ''), null, { role: 'menuitemradio', checked: self.qPref === s.h,
            act: function () { self.setQuality(s.h); self.openMenu('main', true, 'quality'); } });
        });
      } else if (viewName === 'captions') {
        add('Off', null, { role: 'menuitemradio', checked: !self.ccOn, act: function () { self.setCC(false, true); self.openMenu('main', true, 'captions'); } });
        add(self.cfg.captions[0].label, null, { role: 'menuitemradio', checked: self.ccOn, act: function () { self.setCC(true, true); self.openMenu('main', true, 'captions'); } });
      }
    }
    this.menuItems = items;
  };
  Player.prototype.openMenu = function (view, focus, focusKey) {
    this.menu.hidden = false;
    this.bSet.setAttribute('aria-expanded', 'true');
    this.root.classList.add('mlp-menu-open');
    this.renderMenu(view);
    this.showControls();
    if (focus) {
      var items = this.menuItems, target = items[0];
      if (focusKey) items.forEach(function (b) { if (b.dataset.key === focusKey) target = b; });
      else if (view !== 'main') items.forEach(function (b) { if (b.getAttribute('aria-checked') === 'true') target = b; });
      if (target) target.focus();
    }
  };
  Player.prototype.closeMenu = function (refocus) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.menuView = 'main';
    this.bSet.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('mlp-menu-open');
    if (refocus) this.bSet.focus();
    this.hideSoon();
  };
  Player.prototype.menuKey = function (e) {
    var items = this.menuItems || [], i = items.indexOf(document.activeElement), a = document.activeElement;
    var handled = true;
    switch (e.key) {
      case 'ArrowDown': items[(i + 1) % items.length].focus(); break;
      case 'ArrowUp': items[(i - 1 + items.length) % items.length].focus(); break;
      case 'Home': items[0].focus(); break;
      case 'End': items[items.length - 1].focus(); break;
      case 'ArrowRight': if (a && a.getAttribute('aria-haspopup')) a.click(); break;
      case 'ArrowLeft': case 'Backspace':
        if (this.menuView !== 'main') this.openMenu('main', true, this.menuView); else this.closeMenu(true);
        break;
      case 'Escape':
        if (this.menuView !== 'main') this.openMenu('main', true, this.menuView); else this.closeMenu(true);
        break;
      case 'Tab': this.closeMenu(false); handled = false; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    else if (e.key !== 'Tab' && e.key !== 'Enter' && e.key !== ' ') { e.stopPropagation(); }
  };
  Player.prototype.toggleHelp = function (show) {
    if (show == null) show = this.help.hidden;
    this.help.hidden = !show;
    this.root.classList.toggle('mlp-help-open', show);
    if (show) { this.helpReturn = document.activeElement; this.helpClose.focus(); this.showControls(); }
    else {
      var back = this.helpReturn;
      this.helpReturn = null;
      if (back && back !== document.body && document.contains(back) && back !== this.helpClose) back.focus();
      else if (this.root.contains(document.activeElement)) document.activeElement.blur();
      this.hideSoon();
    }
  };

  /* ---------------- keyboard ---------------- */
  Player.prototype.onKey = function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, r = this.root;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (t && (t.isContentEditable || tag === 'textarea' || tag === 'select')) return;
    if (tag === 'input') {
      var type = (t.type || '').toLowerCase();
      var typing = ['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].indexOf(type) === -1;
      if (typing) return;
      if (type === 'range' && /^(Arrow|Home|End|Page)/.test(e.key)) return;
    }
    var inside = r.contains(t);
    if (!inside && t !== document.body && t !== document.documentElement) {
      // Focus is on something else on the page (a link, a button): leave Space and Enter to it.
      if (e.key === ' ' || e.key === 'Enter') return;
      if (t.closest && t.closest('[role="menu"]')) return;
    }
    if (!inside) {
      var rect = r.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    }
    if (!this.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); this.toggleHelp(false); }
      return;
    }
    if (inside && (tag === 'button' || tag === 'a') && (e.key === ' ' || e.key === 'Enter')) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var v = this.video, done = true;
    switch (k) {
      case ' ': case 'k': this.toggle(); this.say(this.isPlaying() ? 'Playing' : 'Paused', null, true); break;
      case 'j': this.skip(-10); break;
      case 'l': this.skip(10); break;
      case 'ArrowLeft': this.skip(-5); break;
      case 'ArrowRight': this.skip(5); break;
      case 'ArrowUp': this.nudgeVolume(0.05); break;
      case 'ArrowDown': this.nudgeVolume(-0.05); break;
      case 'm': this.toggleMute(); break;
      case 'f': this.toggleFs(); break;
      case 't': if (this.cfg.theater && !this.isFs()) this.requestTheater(); else done = false; break;
      case 'n': if (e.shiftKey && this.next) this.goNext(); else done = false; break;
      case 'c': if (this.cfg.captions && this.cfg.captions.length) this.setCC(!this.ccOn, true); else done = false; break;
      case 'i': if (!this.bPip.hidden) this.togglePip(); else done = false; break;
      case '<': case ',': if (e.key === '<' || e.shiftKey) this.stepSpeed(-1); else done = false; break;
      case '>': case '.': if (e.key === '>' || e.shiftKey) this.stepSpeed(1); else done = false; break;
      case '?': this.toggleHelp(true); break;
      case 'Escape': if (!this.menu.hidden) this.closeMenu(true); else done = false; break;
      default:
        if (/^[0-9]$/.test(k)) {
          var d = this.duration();
          this.seekTo(d * parseInt(k, 10) / 10);
          if (!this.started) this.play(false);
        } else done = false;
    }
    if (done) { e.preventDefault(); this.showControls(); }
    void v;
  };

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.mlp[data-mlp]'), function (n) {
      if (!n._mlp) n._mlp = new Player(n);
    });
  }
  window.JoyaPlayer = { init: init, version: 1 };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  void reduceMotion;
})();
