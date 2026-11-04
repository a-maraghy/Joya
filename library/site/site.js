/* JOYA Library -- page behaviour: search, sort, view counts, relative dates, watched progress,
   Continue watching, the watch page (theater, Up next and autoplay, share, description), menus.
   Plain JS. Its only request is GET /api/stats for the counts; the page works without it. */
(function () {
  'use strict';
  var store = {
    get: function (k, d) { try { var v = window.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var params = new URLSearchParams(location.search);
  var counts = {};

  /* ---------------- numbers and dates ---------------- */
  var nf = new Intl.NumberFormat('en');
  function compact(n) {
    if (n < 10000) return nf.format(n);
    if (n < 1e6) return (Math.floor(n / 100) / 10).toString().replace(/\.0$/, '') + 'K';
    return (Math.floor(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
  }
  function viewsText(n, full) {
    if (!n) return full ? 'No views yet' : 'No views';
    return (full ? nf.format(n) : compact(n)) + (n === 1 ? ' view' : ' views');
  }
  function relDate(iso) {
    var p = iso.split('-').map(Number);
    var then = new Date(p[0], p[1] - 1, p[2]);
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var days = Math.round((now - then) / 864e5);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) { var w = Math.floor(days / 7); return w + (w === 1 ? ' week ago' : ' weeks ago'); }
    if (days < 365) { var m = Math.floor(days / 30.4); return m + (m === 1 ? ' month ago' : ' months ago'); }
    var y = Math.floor(days / 365); return y + (y === 1 ? ' year ago' : ' years ago');
  }
  $$('time.rel').forEach(function (t) {
    var iso = t.getAttribute('datetime');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    t.title = t.textContent;
    t.textContent = relDate(iso);
  });

  /* ---------------- top bar search (phone: a button opens it) ---------------- */
  var form = $('#topsearch'), tq = $('#tq');
  var openBtn = $('#search-open'), backBtn = $('#search-back');
  if (openBtn) openBtn.addEventListener('click', function () {
    document.body.classList.add('searching'); openBtn.setAttribute('aria-expanded', 'true'); tq.focus();
  });
  function closeSearch() {
    if (!document.body.classList.contains('searching')) return;
    document.body.classList.remove('searching'); openBtn.setAttribute('aria-expanded', 'false'); openBtn.focus();
  }
  if (backBtn) backBtn.addEventListener('click', closeSearch);
  if (tq) tq.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (tq.value && grid && isHome) return; closeSearch(); } });

  /* ---------------- listing: sort + search ---------------- */
  var grid = $('#grid');
  var isHome = !!(grid && grid.getAttribute('data-home'));
  var cards = grid ? $$(':scope > .card', grid) : [];
  var sortSel = $('#sort');
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  var SORTS = {
    newest: function (a, b) { return cmp(b.dataset.date + b.dataset.added, a.dataset.date + a.dataset.added); },
    views: function (a, b) { return ((counts[b.dataset.id] || {}).v || 0) - ((counts[a.dataset.id] || {}).v || 0) || SORTS.newest(a, b); },
    oldest: function (a, b) { return cmp(a.dataset.date + a.dataset.added, b.dataset.date + b.dataset.added); },
    title: function (a, b) { return a.dataset.title.localeCompare(b.dataset.title, 'en', { sensitivity: 'base', numeric: true }); },
    longest: function (a, b) { return parseFloat(b.dataset.dur) - parseFloat(a.dataset.dur); }
  };
  function words(n) { return n + ' video' + (n === 1 ? '' : 's'); }
  function currentTerms() { return isHome && tq ? tq.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : []; }
  function applyListing(push) {
    if (!grid) return;
    var mode = sortSel ? sortSel.value : 'newest';
    var terms = currentTerms();
    cards.slice().sort(SORTS[mode] || SORTS.newest).forEach(function (c) { grid.appendChild(c); });
    var shown = 0;
    cards.forEach(function (c) {
      var ok = terms.every(function (t) { return c.dataset.text.indexOf(t) !== -1; });
      c.hidden = !ok;
      if (ok) shown++;
    });
    var count = $('#count'), nomatch = $('#nomatch'), rh = $('#results-head');
    if (count && cards.length) count.textContent = terms.length ? (shown + ' of ' + words(cards.length) + ' match') : words(cards.length);
    if (nomatch) { nomatch.hidden = shown !== 0; $('#nomatch-q').textContent = '“' + tq.value.trim() + '”'; }
    grid.hidden = shown === 0;
    if (rh) {
      rh.hidden = !terms.length;
      if (terms.length) $('#results-h').textContent = 'Results for “' + tq.value.trim() + '”';
    }
    var cw = $('#cw');
    if (cw && terms.length) cw.hidden = true; else if (cw && cw.dataset.has) cw.hidden = false;
    if (push) {
      var p = new URLSearchParams(location.search);
      if (sortSel && (mode !== 'newest' || p.has('sort'))) p.set('sort', mode);
      if (terms.length) p.set('q', tq.value.trim()); else p.delete('q');
      var qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    }
  }
  if (grid) {
    if (sortSel) {
      var s = params.get('sort');
      if (!SORTS[s]) s = store.get('joyalib:sort', null);
      if (!SORTS[s]) s = 'newest';
      sortSel.value = s;
      sortSel.addEventListener('change', function () { store.set('joyalib:sort', sortSel.value); applyListing(true); });
    }
    if (isHome && tq) {
      tq.value = params.get('q') || '';
      var deb;
      tq.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(function () { applyListing(true); }, 120); });
      form.addEventListener('submit', function (e) { e.preventDefault(); applyListing(true); });
      var clear = $('#clear-q');
      if (clear) clear.addEventListener('click', function (e) { e.preventDefault(); tq.value = ''; applyListing(true); tq.focus(); });
    }
    applyListing(false);
  }

  /* ---------------- watched progress + Continue watching ---------------- */
  function progressOf(id, dur) {
    if (store.get('joyalib:seen:' + id, null)) {
      var pos = store.get('joyalib:pos:' + id, null);
      return pos ? Math.min(1, pos.t / dur) : 1;
    }
    var p = store.get('joyalib:pos:' + id, null);
    return p && p.t ? Math.min(1, p.t / dur) : 0;
  }
  function markProgress(card) {
    var f = progressOf(card.dataset.id, parseFloat(card.dataset.dur) || 1);
    var w = card.querySelector('.watched');
    if (!w || f <= 0) return;
    w.hidden = false;
    card.classList.add('has-progress');
    w.querySelector('.watched-bar').style.width = Math.max(4, Math.round(f * 100)) + '%';
  }
  $$('.card').forEach(markProgress);
  var cw = $('#cw');
  if (cw && isHome) {
    var list = [];
    cards.forEach(function (c) {
      var p = store.get('joyalib:pos:' + c.dataset.id, null);
      if (p && p.t > 10 && p.at && Date.now() - p.at < 60 * 864e5) list.push({ c: c, at: p.at });
    });
    list.sort(function (a, b) { return b.at - a.at; });
    if (list.length) {
      var ul = $('#cw-list');
      list.slice(0, 4).forEach(function (x) {
        var n = x.c.cloneNode(true);
        n.removeAttribute('id');
        n.hidden = false;
        $$('[id]', n).forEach(function (e) { e.removeAttribute('id'); });
        ul.appendChild(n);
      });
      cw.dataset.has = '1';
      if (!currentTerms().length) cw.hidden = false;
    }
  }

  /* ---------------- view counts ---------------- */
  function paintCounts() {
    $$('[data-views-for]').forEach(function (el) {
      var c = counts[el.getAttribute('data-views-for')];
      if (!c) return;
      if (el.hasAttribute('data-views-full')) {
        el.textContent = viewsText(c.v, true) + (c.v ? ' · ' + nf.format(c.u) + (c.u === 1 ? ' unique viewer' : ' unique viewers') : '');
      } else {
        el.textContent = viewsText(c.v, false);
      }
    });
  }
  window.JoyaCounts = function (key, c) { counts[key] = c; paintCounts(); };
  var keys = [];
  $$('[data-views-for]').forEach(function (el) {
    var k = el.getAttribute('data-views-for');
    if (keys.indexOf(k) === -1) keys.push(k);
  });
  if (keys.length && window.fetch) {
    fetch('/api/stats?ids=' + encodeURIComponent(keys.slice(0, 200).join(',')), { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        Object.keys(data.counts || {}).forEach(function (k) { counts[k] = data.counts[k]; });
        paintCounts();
        if (sortSel && sortSel.value === 'views') applyListing(false);
      }).catch(function () { /* the page stays as it is, without counts */ });
  }

  /* ---------------- watch page ---------------- */
  var watch = $('#watch');
  var mlpRoot = $('.watch .mlp');
  var player = mlpRoot && mlpRoot._mlp;
  if (watch) {
    // Theater mode, remembered.
    var setTheater = function (on) {
      document.body.classList.toggle('theater', on);
      store.set('joyalib:theater', on);
      if (player) player.setTheater(on);
    };
    if (store.get('joyalib:theater', false)) setTheater(true);
    document.addEventListener('mlp:theater', function () {
      setTheater(!document.body.classList.contains('theater'));
      if (mlpRoot) { var r = mlpRoot.getBoundingClientRect(); if (r.top < 0) window.scrollTo(0, 0); }
    });

    // Up next and autoplay.
    var next = null;
    try { next = JSON.parse(watch.getAttribute('data-next') || 'null'); } catch (e) {}
    var auto = $('#autoplay');
    if (auto) {
      auto.checked = !!store.get('joyalib:autoplay', !reduceMotion);
      auto.addEventListener('change', function () {
        store.set('joyalib:autoplay', auto.checked);
        if (player) player.setAutoNext(auto.checked);
      });
    }
    if (player && next) player.setNext(next, auto ? auto.checked : false);

    // Description: clamp to three lines, with Show more / Show less.
    var desc = $('#desc'), dtext = $('#desc-text'), dtog = $('#desc-toggle');
    if (desc && dtext && dtog) {
      var opened = false;
      var measure = function () {
        if (opened) return;
        desc.classList.remove('is-clamped');
        var lh = parseFloat(getComputedStyle(dtext.firstElementChild || dtext).lineHeight) || 24;
        var long = dtext.getBoundingClientRect().height > lh * 3 + 4;
        desc.classList.toggle('is-clamped', long);
        dtog.hidden = !long;
      };
      dtog.addEventListener('click', function () {
        opened = desc.classList.toggle('is-clamped') === false;
        dtog.setAttribute('aria-expanded', opened ? 'true' : 'false');
        dtog.textContent = opened ? 'Show less' : 'Show more';
        if (!opened) measure();
      });
      measure();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
      var rt;
      window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(measure, 150); });
    }

    // Share: link, link at the current time, embed code.
    var shareBtn = $('#share-btn'), panel = $('#share-panel');
    var shareUrl = $('#share-url'), shareAt = $('#share-at'), shareTime = $('#share-time');
    var fmt = function (t) {
      t = Math.floor(t || 0);
      var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
      return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
    };
    var at = 0;
    var syncShare = function () {
      var base = shareUrl.getAttribute('data-base');
      shareUrl.value = shareAt.checked && at > 0 ? base + '?t=' + at : base;
    };
    var openShare = function (on) {
      panel.hidden = !on;
      shareBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        var v = mlpRoot && mlpRoot.querySelector('video');
        at = v ? Math.floor(v.currentTime || 0) : 0;
        shareTime.textContent = fmt(at);
        shareAt.disabled = at <= 0;
        if (at <= 0) shareAt.checked = false;
        syncShare();
        shareUrl.focus(); shareUrl.select();
      }
    };
    if (shareBtn && panel) {
      shareBtn.addEventListener('click', function () { openShare(panel.hidden); });
      $('#share-close').addEventListener('click', function () { openShare(false); shareBtn.focus(); });
      shareAt.addEventListener('change', syncShare);
      panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { openShare(false); shareBtn.focus(); } });
      $('#share-embed').addEventListener('focus', function () { this.select(); });
    }
  }

  /* ---------------- copy buttons ---------------- */
  var status = $('#copy-status');
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); ok ? res() : rej(new Error('copy failed'));
    });
  }
  $$('[data-copy-from]').forEach(function (btn) {
    var label = btn.querySelector('.btn-label');
    var orig = label.textContent, timer;
    btn.addEventListener('click', function () {
      var src = document.getElementById(btn.getAttribute('data-copy-from'));
      copyText(src.value).then(function () {
        btn.classList.add('is-done'); label.textContent = btn.getAttribute('data-copy-label');
        if (status) { status.classList.remove('is-bad'); status.textContent = btn.getAttribute('data-copy-label') + '.'; }
      }, function () {
        src.focus(); src.select();
        if (status) { status.classList.add('is-bad'); status.textContent = 'Could not copy. It is selected: press Ctrl+C (or ⌘C).'; }
      });
      clearTimeout(timer);
      timer = setTimeout(function () { btn.classList.remove('is-done'); label.textContent = orig; if (status) status.textContent = ''; }, 2600);
    });
  });

  /* ---------------- menu button (download) ---------------- */
  $$('[data-menu]').forEach(function (wrap) {
    var btn = wrap.querySelector('[aria-haspopup]');
    var menu = wrap.querySelector('[role="menu"]');
    var items = function () { return $$('[role="menuitem"]', menu); };
    function open(focusFirst) { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); if (focusFirst) items()[0].focus(); }
    function close(refocus) { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    btn.addEventListener('click', function () { menu.hidden ? open(false) : close(false); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open(true); }
    });
    menu.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') { close(false); }
    });
    menu.addEventListener('click', function () { setTimeout(function () { close(false); }, 0); });
    document.addEventListener('pointerdown', function (e) { if (!wrap.contains(e.target)) close(false); });
  });

  /* ---------------- page shortcuts: / to search, ? for help (the player has its own on a watch page) ---------------- */
  var help = null;
  function toggleHelp(show) {
    if (!help) {
      help = document.createElement('div');
      help.className = 'kbd-help';
      help.hidden = true;
      help.innerHTML = '<div class="kbd-help-box" role="dialog" aria-modal="true" aria-labelledby="kbd-h">' +
        '<div class="kbd-help-head"><h2 id="kbd-h">Keyboard shortcuts</h2><button type="button" class="btn">Close</button></div>' +
        '<dl><div><dt><kbd>/</kbd></dt><dd>Search</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Clear the search or close</dd></div>' +
        '<div><dt><kbd>?</kbd></dt><dd>Show these shortcuts</dd></div></dl>' +
        '<p class="muted" style="margin-top:12px">On a video page: Space or K play, J / L skip 10 s, F full screen, T theater, M mute, C captions, 0–9 jump, Shift + N next video.</p></div>';
      document.body.appendChild(help);
      help.querySelector('button').addEventListener('click', function () { toggleHelp(false); });
      help.addEventListener('click', function (e) { if (e.target === help) toggleHelp(false); });
    }
    help.hidden = !show;
    if (show) { help._ret = document.activeElement; help.querySelector('button').focus(); }
    else if (help._ret && help._ret.focus) help._ret.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (help && !help.hidden && e.key === 'Escape') { e.preventDefault(); toggleHelp(false); return; }
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    if (e.key === '/' && tq) {
      e.preventDefault();
      if (openBtn && getComputedStyle(form).display === 'none') openBtn.click(); else tq.focus();
    } else if (e.key === '?' && !player) {
      e.preventDefault(); toggleHelp(!help || help.hidden);
    }
  });
})();
