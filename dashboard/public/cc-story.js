"use strict";
/*
 * The session story and the day timeline (2026-10-20).
 *
 * Opening a session shows a picture of its work instead of text:
 *   - a progress rail: its plan as steps, done / now / next -- a mission's steps when it works on one,
 *     else its todo list, else its turns (each a real prompt it was given);
 *   - beside it: the files it changed (+/- lines as Claude Code recorded them), the approvals it asked
 *     for, its tokens and cost, the time it was active, its hand-offs;
 *   - a scrubber over its own activity: drag it and the rail, files and tokens show that moment.
 *
 * And on the Command Center, a day timeline: drag it and the day replays on the map -- the sessions
 * light up when they worked, JOYA AI's delegations and replies (and messages between sessions) fly as
 * the existing dot streams between the heads, approvals tick amber. "Now" goes back to live.
 *
 * Everything comes from two read-only routes (GET /joya-ai/api/sessions/:sid/story and
 * /joya-ai/api/story/day), the supervisor's lib/story.js. Nothing is invented: a figure the data does not
 * have is not shown.
 *
 * Deep links: /joya-ai?session=<id>&t=<ISO time>; /joya-ai?t=<ISO time> opens the day timeline there.
 * Other builds link in with:
 *     JoyaStory.open(sessionId, t)      // t: ms, ISO string, Date, or null for live
 *     JoyaStory.link(sessionId, t)      // -> "/joya-ai?session=…&t=…"
 *     JoyaStory.replay(t)               // the day timeline at t (null: live)
 *
 * No style attribute (the CSP refuses them): positions and widths go through element.style. Every class
 * starts with cc-. prefers-reduced-motion: no easing, the replay steps instead of gliding.
 *
 * The pure helpers are exported (module.exports) for dashboard/tools/test-session-story.cjs.
 */
(function () {
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var MIN = 60000, HOUR = 3600000;

  /* ================================================================ pure helpers */

  function ms(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v instanceof Date) return isFinite(v.getTime()) ? v.getTime() : null;
    var x = Date.parse(String(v));
    return isFinite(x) ? x : null;
  }
  /** A ?t= value: an ISO time, epoch seconds or milliseconds. null if none or unreadable. */
  function parseT(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (/^\d{10}$/.test(s)) return Number(s) * 1000;
    if (/^\d{12,13}$/.test(s)) return Number(s);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
    return ms(s);
  }
  /** The link form of a time: ISO to the minute, "2026-10-20T13:05Z". */
  function fmtT(t) {
    var x = ms(t);
    return x == null ? "" : new Date(x).toISOString().slice(0, 16) + "Z";
  }
  function parseLink(search) {
    var q = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    var s = q.get("session");
    return { session: s && UUID_RE.test(s) ? s : null, t: parseT(q.get("t")) };
  }
  /** The same page with ?session / ?t set (or removed when null), every other parameter kept. */
  function linkFor(pathname, search, session, t) {
    var q = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    if (session && UUID_RE.test(session)) q.set("session", session); else q.delete("session");
    if (ms(t) != null) q.set("t", fmtT(t)); else q.delete("t");
    var s = q.toString();
    return (pathname || "/joya-ai") + (s ? "?" + s : "");
  }

  /**
   * The rail as of a moment: each step's status at t (null: as it is now). A step with no times keeps
   * the status it has (a mission step that was never timed); one with times is next before it began,
   * now while it ran and done (or failed / skipped) once it ended.
   */
  function railAt(steps, t) {
    t = ms(t);
    return (steps || []).map(function (s, i) {
      var o = {}; for (var k in s) o[k] = s[k];
      o.i = i;
      if (t == null) { o.at = s.status; return o; }
      var a = ms(s.t0), b = ms(s.t1);
      if (a == null && b == null) { o.at = s.status; o.untimed = true; return o; }
      if (a != null && t < a) o.at = "next";
      else if (b != null && t >= b) o.at = s.status === "failed" || s.status === "skipped" ? s.status : "done";
      else if (a == null) o.at = "next";
      else o.at = "now";
      return o;
    });
  }
  /** Which steps to draw (at most max): the window round the current one, with the counts left out each side. */
  function railWindow(steps, max) {
    max = Math.max(1, max || 7);
    var n = steps.length, focus = -1, i;
    for (i = n - 1; i >= 0; i--) if (steps[i].at === "now") { focus = i; break; }
    if (focus < 0) { for (i = 0; i < n; i++) if (steps[i].at === "next") { focus = i; break; } }
    if (focus < 0) focus = n - 1;
    var start = Math.max(0, Math.min(n - max, focus - Math.floor(max * 0.6)));
    if (n <= max) start = 0;
    var items = steps.slice(start, start + max);
    return { items: items, before: start, after: Math.max(0, n - start - items.length), focus: focus };
  }
  function railCounts(steps) {
    var c = { done: 0, now: 0, next: 0, failed: 0, skipped: 0 };
    (steps || []).forEach(function (s) { c[s.at || s.status] = (c[s.at || s.status] || 0) + 1; });
    return c;
  }
  /** The files changed by t (null: all, as the server added them up), latest first. */
  function filesAt(story, t) {
    t = ms(t);
    if (t == null) return (story.files || []).slice();
    var m = {};
    (story.file_events || []).forEach(function (e) {
      var x = ms(e.t);
      if (x == null || x > t) return;
      var f = m[e.path] || (m[e.path] = { path: e.path, add: 0, del: 0, edits: 0, last: e.t });
      f.add += e.add || 0; f.del += e.del || 0; f.edits++;
      if (String(e.t) > String(f.last)) f.last = e.t;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return String(b.last).localeCompare(String(a.last)); });
  }
  function totalsOf(files) {
    return files.reduce(function (a, f) { a.add += f.add || 0; a.del += f.del || 0; return a; }, { add: 0, del: 0 });
  }
  /** Items with a time at or before t (null: all). */
  function upTo(list, t) {
    t = ms(t);
    return (list || []).filter(function (x) { var v = ms(x.t); return t == null || (v != null && v <= t); });
  }
  /** The story's own bins up to t: { records, tokens, blocks (5-minute blocks with activity) }. */
  function binsUpTo(story, t) {
    var from = ms(story.bin_from), w = story.bin_ms || 300000, out = { records: 0, tokens: 0, blocks: 0 };
    t = ms(t);
    (story.bins || []).forEach(function (b) {
      if (t != null && from != null && from + b[0] * w > t) return;
      out.records += b[1]; out.tokens += b[2]; out.blocks++;
    });
    return out;
  }
  /** Hand-offs with a time in (a, b]. */
  function between(list, a, b) {
    return (list || []).filter(function (h) { var v = ms(h.t); return v != null && v > a && v <= b; });
  }

  /** Was this session waiting on an approval at t (a card raised and not yet answered)? */
  function waitingAt(day, sid, t) {
    return (day.approvals || []).some(function (a) {
      if (a.sid !== sid) return false;
      var c = ms(a.t), d = ms(a.decided_at);
      return c != null && c <= t && (d == null ? a.status === "pending" : t < d);
    });
  }
  function binIndex(day, t) { return Math.floor((t - ms(day.from)) / (day.bin_ms || 300000)); }
  function recsNear(s, bi) {
    var n = 0;
    (s.bins || []).forEach(function (b) { if (b[0] === bi || b[0] === bi - 1) n += b[1]; });
    return n;
  }
  function tokensBy(s, bi) {
    var n = 0;
    (s.bins || []).forEach(function (b) { if (b[0] <= bi) n += b[2]; });
    return n;
  }
  /**
   * The spheres at moment t of the day: every session that existed then (first <= t <= last + 20 min),
   * working when it wrote anything in this or the previous 5 minutes, waiting when it had an approval
   * open, else idle. JOYA AI is the core, not a sphere. -> nodes in cc-family's shape.
   */
  function replayNodes(day, t, opt) {
    opt = opt || {};
    var max = opt.max || 8, bi = binIndex(day, t), out = [];
    (day.sessions || []).forEach(function (s) {
      if (s.self) return;
      var a = ms(s.first), b = ms(s.last);
      if (a == null || t < a || t > b + 20 * MIN) return;
      var n = recsNear(s, bi), wait = waitingAt(day, s.session_id, t);
      var st = wait ? "waiting" : n > 0 ? "working" : "idle";
      var tok = tokensBy(s, bi);
      out.push({
        id: s.session_id, label: clip(s.name || "session", 26), name: s.name || "session", st: st, subs: [], mission: "",
        tok: tok ? fmtTok(tok) + " tokens by then" : "", tokTip: "", task: (st === "working" ? "Working" : st === "waiting" ? "Waiting on an approval" : "Idle") + " at " + (opt.hm ? opt.hm(t) : fmtT(t)),
        last: "", act: 1 + Math.min(20, tok / 5e5) + (st === "working" ? 2 : 0), hired: !!s.hired, slug: null,
        head: opt.headFor ? opt.headFor(s) : "", _n: n, _r: s.records || 0,
      });
    });
    out.sort(function (x, y) { return (y._n > 0) - (x._n > 0) || y._r - x._r; });
    return out.slice(0, max).map(function (x) { delete x._n; delete x._r; return x; });
  }
  function selfActiveAt(day, t) {
    var bi = binIndex(day, t);
    return (day.sessions || []).some(function (s) { return s.self && recsNear(s, bi) > 0; });
  }
  /** Activity per bin over the day: { total: [records per bin], max } (for the track's heat). */
  function dayHeat(day) {
    var n = day.bins || 288, total = new Array(n), mx = 0, i;
    for (i = 0; i < n; i++) total[i] = 0;
    (day.sessions || []).forEach(function (s) { (s.bins || []).forEach(function (b) { if (b[0] >= 0 && b[0] < n) total[b[0]] += b[1]; }); });
    for (i = 0; i < n; i++) if (total[i] > mx) mx = total[i];
    return { total: total, max: mx };
  }
  function laneHeat(s, n) {
    var a = new Array(n), mx = 0, i;
    for (i = 0; i < n; i++) a[i] = 0;
    (s.bins || []).forEach(function (b) { if (b[0] >= 0 && b[0] < n) { a[b[0]] += b[1]; if (a[b[0]] > mx) mx = a[b[0]]; } });
    return { v: a, max: mx };
  }
  function fmtTok(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  function fmtDur(d) {
    if (d == null || !isFinite(d) || d < 0) return "—";
    var m = Math.round(d / MIN);
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  }
  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  /** A path as people read it: relative to the session's folder, else its last two parts. */
  function shortPath(p, cwd) {
    p = String(p || "");
    if (cwd && p.indexOf(String(cwd).replace(/\/$/, "") + "/") === 0) return p.slice(String(cwd).replace(/\/$/, "").length + 1);
    var parts = p.split("/").filter(Boolean);
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
  }
  /** YYYY-MM-DD of an instant in a zone. */
  function dayOf(t, tz) {
    try {
      var f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
      return f.format(new Date(t));
    } catch (e) { return new Date(t).toISOString().slice(0, 10); }
  }
  function shiftDay(day, n) {
    var p = String(day).split("-").map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  var L = {
    ms: ms, parseT: parseT, fmtT: fmtT, parseLink: parseLink, linkFor: linkFor, railAt: railAt, railWindow: railWindow, railCounts: railCounts,
    filesAt: filesAt, totalsOf: totalsOf, upTo: upTo, binsUpTo: binsUpTo, between: between, waitingAt: waitingAt, replayNodes: replayNodes,
    selfActiveAt: selfActiveAt, dayHeat: dayHeat, laneHeat: laneHeat, fmtTok: fmtTok, fmtDur: fmtDur, shortPath: shortPath, dayOf: dayOf, shiftDay: shiftDay, clip: clip,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = L;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  /* ================================================================ the page */

  var CC = null, P = null;
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var TZ = "Africa/Cairo", fHM = null, fDay = null;
  try {
    fHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    fDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  } catch (e) { /* the browser's zone */ }
  function hmOf(t) { var x = ms(t); return x == null ? "" : fHM ? fHM.format(new Date(x)) : new Date(x).toTimeString().slice(0, 5); }
  function dayLabel(day) { var p = String(day).split("-").map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); return fDay ? fDay.format(d) : day; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function light() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "light";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }
  function cssVar(n, fb) { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v && v.trim()) || fb; }
  /** A track's canvas sits 6 px in from each side: where fraction k is, and which fraction a pointer is at. */
  function atFrac(el, k) { k = Math.max(0, Math.min(1, k)); el.style.left = "calc(6px + " + (k * 100).toFixed(3) + "% - " + (12 * k).toFixed(2) + "px)"; }
  function fracAt(e) { var r = e.currentTarget.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left - 6) / Math.max(1, r.width - 12))); }
  function phone() { return window.innerWidth <= 720 && !document.documentElement.classList.contains("cc-desk"); }

  var ICON = {
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5v9M9.5 10a2.5 2 0 0 1 2.5-1.5c1.4 0 2.5.7 2.5 1.7 0 2.4-5 1.2-5 3.6 0 1 1.1 1.7 2.5 1.7a2.5 2 0 0 0 2.5-1.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    hand: '<path d="M4 12h11M11 7l5 5-5 5"/><path d="M20 5v14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/><path d="M12 8v4l2.6 1.6"/>',
    live: '<circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>',
    lanes: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    chevl: '<path d="M15 6l-6 6 6 6"/>',
    chevr: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M7 7l10 10M17 7 7 17"/>',
  };
  function ic(n, cls) { return '<svg class="cc-st-i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[n] || "") + "</svg>"; }

  function api(path) {
    if (CC && CC.api) return CC.api(path);
    return fetch("/joya-ai/api/" + path, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
    });
  }
  function toast(t, bad) { if (CC && CC.toast) CC.toast(t, bad); }

  /** The URL bar follows the story and the replay, so the address is a link to this moment. */
  function syncUrl() {
    if (!history.replaceState) return;
    var sid = Story.sid && Story.el ? Story.sid : null;
    var t = Story.el ? Story.t : Day.t;
    var url = linkFor(location.pathname, location.search, sid, t) + location.hash;
    if (url !== location.pathname + location.search + location.hash) { try { history.replaceState(history.state, "", url); } catch (e) { /* sandboxed */ } }
  }

  function headFor(s) {
    var ML = window.JoyaLogic;
    if (!ML || !ML.botHeadFor) return "cap";
    var team = {};
    try { team = JSON.parse((document.getElementById("cc") || document.body).getAttribute("data-bot-team") || "{}"); } catch (e) { team = {}; }
    return ML.botHeadFor({ name: s.name, cwd: s.cwd }, team).head;
  }
  function paintHead(cv, head, state, px) {
    if (!cv) return;
    if (window.JoyaBot && window.JoyaBot.thumb) {
      try { window.JoyaBot.thumb(cv, head || "cap", { state: state || "idle", light: light(), w: px, h: px }); return; } catch (e) { /* fall through */ }
    }
    cv.hidden = true;
  }

  /* ================================================================ the story */

  var Story = { el: null, sid: null, t: null, data: null, err: null, timer: 0, prevFocus: null, req: 0, drag: false, page: 0 };

  function storyShell() {
    var root = document.createElement("div");
    root.className = "cc-st-root";
    root.id = "cc-story";
    root.innerHTML =
      '<div class="cc-st-scrim" data-st-close></div>' +
      '<section class="cc-st" role="dialog" aria-modal="true" aria-labelledby="cc-st-title" tabindex="-1">' +
      '<header class="cc-st-h"><canvas class="cc-st-head" aria-hidden="true"></canvas><div class="cc-st-ht"><h2 id="cc-st-title">Session</h2><small class="cc-st-sub"></small></div>' +
      '<div class="cc-st-acts"><span class="cc-st-pill" data-st="state"></span>' +
      '<button type="button" class="cc-st-btn" data-st-act="link" title="Copy a link to this moment">' + ic("link") + '<span>Link</span></button>' +
      '<button type="button" class="cc-st-btn" data-st-act="mirror" title="The transcript, as text (read-only)">' + ic("eye") + '<span>Live mirror</span></button>' +
      '<button type="button" class="cc-st-x" data-st-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></header>" +
      '<div class="cc-st-body">' +
      '<div class="cc-st-moment"><div class="cc-st-mtrack" role="slider" tabindex="0" aria-label="Moment in this session"><canvas aria-hidden="true"></canvas><span class="cc-st-mhandle" aria-hidden="true"></span></div>' +
      '<div class="cc-st-mlab"><b data-st="at">Live</b><button type="button" class="cc-st-now" data-st-act="now" hidden>' + ic("live") + "Now</button></div></div>" +
      '<div class="cc-st-railbox"><div class="cc-st-sec"><b>Progress</b><span data-st="railsrc"></span></div><ol class="cc-st-rail" data-st="rail"></ol></div>' +
      '<div class="cc-st-grid" data-st="grid"></div>' +
      "</div></section>";
    document.body.appendChild(root);
    root.addEventListener("click", storyClick);
    root.addEventListener("keydown", storyKey);
    var tr = root.querySelector(".cc-st-mtrack");
    tr.addEventListener("pointerdown", function (e) { Story.drag = true; tr.setPointerCapture(e.pointerId); momentFrom(e); });
    tr.addEventListener("pointermove", function (e) { if (Story.drag) momentFrom(e); });
    tr.addEventListener("pointerup", function () { Story.drag = false; syncUrl(); });
    tr.addEventListener("pointercancel", function () { Story.drag = false; });
    tr.addEventListener("keydown", momentKey);
    return root;
  }

  function open(sid, t, opt) {
    if (!sid || !UUID_RE.test(String(sid))) return false;
    opt = opt || {};
    if (!Story.el) Story.el = storyShell();
    var same = Story.sid === sid && Story.data;
    Story.sid = sid;
    Story.t = ms(t);
    Story.key = opt.key || sid;
    Story.page = 0;
    if (!same) { Story.data = null; Story.err = null; }
    Story.prevFocus = document.activeElement;
    Story.el.hidden = false;
    document.documentElement.classList.add("cc-st-open");
    renderStory();
    fetchStory();
    clearInterval(Story.timer);
    Story.timer = setInterval(function () { if (!document.hidden && Story.t == null) fetchStory(); }, 10000);
    var dlg = Story.el.querySelector(".cc-st");
    try { dlg.focus({ preventScroll: true }); } catch (e) { dlg.focus(); }
    syncUrl();
    return true;
  }
  function close() {
    if (!Story.el || Story.el.hidden) return;
    clearInterval(Story.timer);
    Story.el.hidden = true;
    document.documentElement.classList.remove("cc-st-open");
    Story.sid = null; Story.t = null;
    syncUrl();
    if (Story.prevFocus && Story.prevFocus.focus && document.contains(Story.prevFocus)) Story.prevFocus.focus();
  }
  function fetchStory() {
    var sid = Story.sid, n = ++Story.req;
    api("sessions/" + encodeURIComponent(sid) + "/story").then(function (r) {
      if (n !== Story.req || sid !== Story.sid) return;
      // An answer without a plan: a supervisor from before the story (it needs a restart to know the op).
      if (!r || !r.plan || !r.session) { Story.data = null; Story.err = "JOYA AI's supervisor did not return a story"; renderStory(); return; }
      Story.data = r; Story.err = null; renderStory();
    }).catch(function (e) {
      if (n !== Story.req || sid !== Story.sid) return;
      Story.err = e && e.message ? e.message : String(e); renderStory();
    });
  }
  function span(d) {
    var a = ms(d.time && d.time.first), b = ms(d.time && d.time.last);
    if (a == null) return null;
    if (d.session && d.session.live) b = Math.max(b || a, Date.now());
    return { a: a, b: Math.max(b || a, a + MIN) };
  }
  function setMoment(t, quiet) {
    var d = Story.data; if (!d) return;
    var sp = span(d); if (!sp) return;
    if (t != null && d.session && d.session.live && t >= sp.b - MIN) t = null; // the end of a live session is "now"
    else if (t != null) t = Math.max(sp.a, Math.min(sp.b, t));
    Story.t = t;
    renderStory();
    if (!quiet) syncUrl();
  }
  function momentFrom(e) {
    var d = Story.data; if (!d) return;
    var sp = span(d); if (!sp) return;
    setMoment(sp.a + fracAt(e) * (sp.b - sp.a), true);
  }
  function momentKey(e) {
    var d = Story.data; if (!d) return;
    var sp = span(d); if (!sp) return;
    var cur = Story.t == null ? sp.b : Story.t, step = e.shiftKey ? HOUR : 5 * MIN, n = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") n = cur - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") n = cur + step;
    else if (e.key === "PageDown") n = cur - HOUR;
    else if (e.key === "PageUp") n = cur + HOUR;
    else if (e.key === "Home") n = sp.a;
    else if (e.key === "End") n = sp.b;
    if (n == null) return;
    e.preventDefault();
    setMoment(n);
  }
  function storyKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    var f = Story.el.querySelectorAll("button:not([hidden]), [tabindex='0']");
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function storyClick(e) {
    if (e.target.closest("[data-st-close]")) { close(); return; }
    var b = e.target.closest("[data-st-act]");
    if (b) {
      var a = b.getAttribute("data-st-act");
      if (a === "now") setMoment(null);
      else if (a === "link") copyLink();
      else if (a === "mirror") { var key = Story.key; close(); if (P && P.openDeep) P.openDeep(key, { mirror: true }); }
      else if (a === "page-") { Story.page--; renderStory(); }
      else if (a === "page+") { Story.page++; renderStory(); }
      return;
    }
    var st = e.target.closest("[data-st-step]");
    if (st && Story.data) {
      var s = (Story.data.plan.steps || [])[Number(st.getAttribute("data-st-step"))];
      var t0 = s && ms(s.t0);
      if (t0 != null) setMoment(Math.max(t0, ms(s.t1) != null ? ms(s.t1) - 1 : t0));
    }
  }
  function copyLink() {
    var url = location.origin + linkFor("/joya-ai", "", Story.sid, Story.t);
    var done = function () { toast("Link copied: " + (Story.t == null ? "this session, live" : "this session at " + hmOf(Story.t))); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url); });
    else toast(url);
  }

  function stepHTML(s, cls) {
    var lab = s.at === "done" ? "done" : s.at === "now" ? "now" : s.at === "failed" ? "failed" : s.at === "skipped" ? "skipped" : "next";
    var when = ms(s.t0) != null ? hmOf(s.t0) + (ms(s.t1) != null && s.at !== "now" ? " · " + fmtDur(ms(s.t1) - ms(s.t0)) : s.at === "now" ? " · running" : "") : s.untimed ? "not timed" : "";
    var who = s.peer ? "from " + s.peer : s.target && !s.mine ? (/^(joya-ai|joya ai|joya ai)$/i.test(s.target) ? "JOYA AI" : s.target) : "";
    return '<li class="cc-st-step ' + lab + (s.mine === false ? " other" : "") + (cls || "") + '"' + (ms(s.t0) != null ? ' data-st-step="' + s.i + '" tabindex="0" role="button"' : "") +
      ' aria-label="' + esc((s.n ? "Step " + s.n + ": " : "") + s.title + ", " + lab + (when ? ", " + when : "")) + '">' +
      '<span class="cc-st-node" aria-hidden="true">' + (lab === "done" ? ic("check") : lab === "failed" ? ic("x") : "") + "</span>" +
      '<span class="cc-st-stxt"><b>' + esc(clip(s.title, 90)) + "</b><small>" + esc([s.n ? "step " + s.n : "", lab === "now" ? "now" : lab === "next" ? "next" : "", when, who].filter(Boolean).join(" · ")) + "</small></span></li>";
  }

  function card(cls, icon, title, aside, body) {
    return '<article class="cc-st-card ' + cls + '"><div class="cc-st-sec">' + ic(icon) + "<b>" + esc(title) + "</b>" + (aside ? "<span>" + aside + "</span>" : "") + "</div>" + body + "</article>";
  }

  function renderStory() {
    var root = Story.el; if (!root) return;
    var d = Story.data, t = Story.t;
    var q = function (k) { return root.querySelector('[data-st="' + k + '"]'); };
    var s = (d && d.session) || {};
    var live = CC && CC.findSess ? CC.findSess(Story.key) || CC.findSess(Story.sid) : null;
    var name = s.name || (live && live.name) || "Session";
    $("cc-st-title").textContent = name;
    var state = t != null ? "replay" : s.state || (live ? (CC.sessState ? CC.sessState(live) : "idle") : "offline");
    var pill = q("state");
    pill.textContent = t != null ? "At " + hmOf(t) : state === "waiting" ? "Waiting on you" : state;
    pill.className = "cc-st-pill " + state;
    root.querySelector(".cc-st-sub").textContent = [s.cwd, s.where, s.hired ? "hired" : "", s.self ? "JOYA AI itself" : ""].filter(Boolean).join(" · ") || (Story.err ? "" : "reading its transcript…");
    paintHead(root.querySelector(".cc-st-head"), s.self ? (document.getElementById("cc") || document.body).getAttribute("data-bot-head") || "cap" : headFor(s.name ? s : { name: name }), t != null ? "idle" : state === "working" ? "thinking" : state === "waiting" ? "needs" : "idle", 44);
    var mirrorBtn = root.querySelector('[data-st-act="mirror"]');
    mirrorBtn.hidden = !(P && P.openDeep);

    var railEl = q("rail"), grid = q("grid");
    if (!d) {
      railEl.innerHTML = '<li class="cc-st-empty">' + esc(Story.err ? "Could not read the story: " + Story.err : "Reading the transcript…") + "</li>";
      grid.innerHTML = "";
      q("railsrc").textContent = "";
      drawMoment();
      return;
    }
    // the rail
    var steps = railAt(d.plan.steps || [], t);
    var cnt = railCounts(steps);
    var max = phone() ? 5 : window.innerWidth < 1100 ? 5 : 7;
    var w = railWindow(steps, max);
    if (Story.page) {
      var shift = Story.page * max, st0 = Math.max(0, Math.min(steps.length - w.items.length, w.before + shift));
      w = { items: steps.slice(st0, st0 + max), before: st0, after: Math.max(0, steps.length - st0 - max) };
    }
    var src = d.plan.source === "mission" ? "Mission " + esc(d.plan.mission.ref) + " · " + esc(clip(d.plan.mission.title || "", 60))
      : d.plan.source === "todos" ? "Its todo list"
      : steps.length ? "Its turns: each one a prompt it was given" : "";
    q("railsrc").innerHTML = (src ? src + " · " : "") + (steps.length ? cnt.done + " done" + (cnt.now ? " · " + cnt.now + " now" : "") + (cnt.next ? " · " + cnt.next + " next" : "") + (cnt.failed ? " · " + cnt.failed + " failed" : "") : "");
    railEl.innerHTML = !steps.length ? '<li class="cc-st-empty">' + (s.transcript === false ? "No transcript on this box to read." : "No prompts in its transcript yet.") + "</li>"
      : (w.before ? '<li class="cc-st-more"><button type="button" class="cc-st-btn sm" data-st-act="page-">' + ic("chevl") + w.before + " earlier</button></li>" : "") +
        w.items.map(function (x) { return stepHTML(x); }).join("") +
        (w.after ? '<li class="cc-st-more"><button type="button" class="cc-st-btn sm" data-st-act="page+">' + w.after + " later" + ic("chevr") + "</button></li>" : "");

    // the cards
    var files = filesAt(d, t), tot = t == null ? d.file_totals || totalsOf(files) : totalsOf(files);
    var maxL = files.reduce(function (a, f) { return Math.max(a, (f.add || 0) + (f.del || 0)); }, 1);
    var fb = files.length ? '<ul class="cc-st-files">' + files.slice(0, 8).map(function (f) {
      return '<li title="' + esc(f.path) + '"><span class="p">' + esc(shortPath(f.path, s.cwd)) + "</span>" +
        '<span class="n"><i class="a">+' + (f.add || 0) + '</i><i class="d">−' + (f.del || 0) + "</i></span>" +
        '<span class="bar" aria-hidden="true"><span class="ba" data-w="' + ((f.add || 0) / maxL) + '"></span><span class="bd" data-w="' + ((f.del || 0) / maxL) + '"></span></span></li>';
    }).join("") + "</ul>" + (files.length > 8 ? '<p class="cc-st-foot">and ' + (files.length - 8) + " more</p>" : "")
      : '<p class="cc-st-none">' + (t == null ? "No file changed through its edit tools." : "No file changed by then.") + "</p>";
    var filesCard = card("files", "file", "Files touched", files.length ? files.length + " · <i class=\"a\">+" + tot.add + '</i> <i class="d">−' + tot.del + "</i>" : "", fb);

    var ap = upTo(d.approvals, t), q2 = upTo(d.questions, t);
    var nOk = ap.filter(function (a) { return a.decision === "approved"; }).length, nNo = ap.filter(function (a) { return a.decision === "denied" || a.decision === "expired"; }).length, nWait = ap.filter(function (a) { return a.decision === "pending"; }).length;
    var apb = ap.length ? '<ul class="cc-st-list">' + ap.slice(-6).reverse().map(function (a) {
      return '<li class="' + esc(a.decision) + '"><time>' + esc(hmOf(a.t)) + '</time><code title="' + esc(a.summary || "") + '">' + esc(clip(a.summary || a.tool || "a tool call", 70)) + "</code><em>" + esc(a.decision === "approved" ? (a.how === "always" ? "allowed always" : "approved") : a.decision) + "</em></li>";
    }).join("") + "</ul>" : '<p class="cc-st-none">' + (s.self || s.hired ? "No approval asked." : "None recorded: an interactive session's approvals show only where Claude Code wrote the decision down.") + "</p>";
    if (q2.length) apb += '<p class="cc-st-foot">' + q2.length + (q2.length === 1 ? " question" : " questions") + " asked of you · last at " + esc(hmOf(q2[q2.length - 1].t)) + "</p>";
    var apCard = card("appr", "shield", "Approvals", ap.length ? ap.length + " asked" + (nOk ? " · " + nOk + " ok" : "") + (nNo ? " · " + nNo + " no" : "") + (nWait ? " · " + nWait + " waiting" : "") : "", apb);

    var bu = binsUpTo(d, t), tk = d.tokens || {}, cost = d.cost || null;
    var tokB = '<div class="cc-st-figs"><div><b>' + esc(fmtTok(t == null ? tk.total : bu.tokens)) + "</b><span>" + (t == null ? "tokens, whole session" : "tokens by then") + "</span></div>" +
      (t == null ? "<div><b>" + esc(fmtTok(tk.output)) + "</b><span>out</span></div><div><b>" + esc(fmtTok((tk.input || 0) + (tk.cache_read || 0) + (tk.cache_write || 0))) + "</b><span>in + cache</span></div>" : "") +
      (cost && cost.today_usd != null ? "<div><b>$" + esc(Number(cost.today_usd).toFixed(2)) + "</b><span>" + (cost.estimated ? "today, est." : "today") + "</span></div>" : "") + "</div>" +
      '<canvas class="cc-st-tokspark" aria-hidden="true"></canvas>';
    var tokCard = card("tok", "coin", "Tokens & cost", cost && cost.estimated ? "API-equivalent estimate" : "", tokB);

    var tm = d.time || {}, sp = span(d);
    // turns by then: known when the rail is the turns themselves
    var turnsBy = t == null ? d.turns || 0 : d.plan.source === "turns" ? steps.filter(function (x) { return x.at !== "next"; }).length : null;
    var timeB = '<div class="cc-st-figs"><div><b>' + esc(fmtDur(t == null ? tm.active_ms : bu.blocks * 5 * MIN)) + "</b><span>" + (t == null ? "active" : "active blocks by then") + "</span></div>" +
      "<div><b>" + esc(fmtDur(t == null ? tm.span_ms : sp ? t - sp.a : null)) + "</b><span>" + (t == null ? "first to last" : "since it began") + "</span></div>" +
      (turnsBy != null ? "<div><b>" + esc(String(turnsBy)) + "</b><span>" + (t == null ? "turns" : "turns by then") + "</span></div>" : "") + "</div>" +
      '<p class="cc-st-foot">' + (tm.first ? "From " + esc(hmOf(tm.first)) + " " + esc(dayLabel(dayOf(ms(tm.first), TZ))) : "") + (tm.last ? " · last activity " + esc(hmOf(tm.last)) : "") + "</p>";
    var timeCard = card("time", "clock", "Time spent", "", timeB);

    var ho = upTo(d.handoffs, t), ag = upTo(d.agents, t);
    var hob = (ho.length ? '<ul class="cc-st-list ho">' + ho.slice(-5).reverse().map(function (h) {
      return '<li class="' + esc(h.kind) + '"><time>' + esc(hmOf(h.t)) + "</time><span><b>" + esc(clip(h.from || "", 22)) + "</b> → <b>" + esc(clip(h.to || "", 22)) + '</b> <span class="cc-st-txt">' + esc(clip(h.text || "", 80)) + "</span></span></li>";
    }).join("") + "</ul>" : '<p class="cc-st-none">No hand-off in or out.</p>') +
      (ag.length ? '<p class="cc-st-foot">' + ag.length + (ag.length === 1 ? " sub-agent" : " sub-agents") + " started · last: " + esc(clip(ag[ag.length - 1].description, 60)) + "</p>" : "");
    var hoCard = card("ho", "hand", "Hand-offs", ho.length ? String(ho.length) : "", hob);

    grid.innerHTML = filesCard + apCard + tokCard + timeCard + hoCard;
    grid.querySelectorAll("[data-w]").forEach(function (el) { el.style.width = (Math.max(0, Math.min(1, Number(el.getAttribute("data-w")))) * 100).toFixed(1) + "%"; });
    root.querySelector('[data-st-act="now"]').hidden = t == null || !s.live;
    q("at").textContent = t == null ? (s.live ? "Live" : "Whole session") : "At " + hmOf(t) + " · " + dayLabel(dayOf(t, TZ));
    drawMoment();
    drawTokSpark(grid.querySelector(".cc-st-tokspark"));
  }

  function drawBars(cv, bins, n, colA, mark) {
    if (!cv) return;
    var r = cv.getBoundingClientRect(), W = Math.max(10, r.width), H = Math.max(10, r.height), dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var mx = 1, i; for (i = 0; i < bins.length; i++) if (bins[i] > mx) mx = bins[i];
    var bw = W / Math.max(1, n);
    g.fillStyle = cssVar("--line", "rgba(127,127,127,.25)");
    g.fillRect(0, H - 1, W, 1);
    for (i = 0; i < n; i++) {
      var v = bins[i] || 0; if (!v) continue;
      var h = Math.max(2, Math.sqrt(v / mx) * (H - 3));
      g.globalAlpha = mark != null && i > mark ? 0.28 : 0.9;
      g.fillStyle = colA;
      g.fillRect(i * bw + (bw > 3 ? 0.5 : 0), H - 1 - h, Math.max(1, bw - (bw > 3 ? 1 : 0)), h);
    }
    g.globalAlpha = 1;
  }
  function storyBins(d) {
    var sp = span(d); if (!sp) return null;
    var from = ms(d.bin_from), w = d.bin_ms || 300000, n = Math.max(1, Math.ceil((sp.b - from) / w)), arr = new Array(n), tok = new Array(n);
    for (var i = 0; i < n; i++) { arr[i] = 0; tok[i] = 0; }
    (d.bins || []).forEach(function (b) { if (b[0] < n) { arr[b[0]] = b[1]; tok[b[0]] = b[2]; } });
    return { from: from, w: w, n: n, rec: arr, tok: tok, sp: sp };
  }
  function drawMoment() {
    var root = Story.el, d = Story.data; if (!root) return;
    var tr = root.querySelector(".cc-st-mtrack"), cv = tr.querySelector("canvas"), hd = tr.querySelector(".cc-st-mhandle");
    var sb = d ? storyBins(d) : null;
    if (!sb) { drawBars(cv, [], 1, cssVar("--accent", "#00a57a")); hd.hidden = true; tr.setAttribute("aria-valuetext", "no activity"); return; }
    var t = Story.t == null ? sb.sp.b : Story.t, k = (t - sb.sp.a) / Math.max(1, sb.sp.b - sb.sp.a);
    var mark = Math.floor((t - sb.from) / sb.w);
    drawBars(cv, sb.rec, sb.n, cssVar("--accent", "#00a57a"), Story.t == null ? null : mark);
    hd.hidden = false;
    atFrac(hd, k);
    tr.setAttribute("aria-valuemin", String(sb.sp.a)); tr.setAttribute("aria-valuemax", String(sb.sp.b)); tr.setAttribute("aria-valuenow", String(Math.round(t)));
    tr.setAttribute("aria-valuetext", Story.t == null ? "now" : hmOf(t));
  }
  function drawTokSpark(cv) {
    var d = Story.data; if (!cv || !d) return;
    var sb = storyBins(d); if (!sb) { cv.hidden = true; return; }
    // cumulative tokens, the part after the moment faded
    var cum = [], c = 0; for (var i = 0; i < sb.n; i++) { c += sb.tok[i]; cum.push(c); }
    var r = cv.getBoundingClientRect(), W = Math.max(10, r.width), H = Math.max(10, r.height), dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var mx = Math.max(1, c), mark = Story.t == null ? sb.n : Math.floor((Story.t - sb.from) / sb.w);
    g.lineWidth = 1.6; g.strokeStyle = cssVar("--accent", "#00a57a");
    g.beginPath();
    for (i = 0; i < sb.n && i <= mark; i++) { var x = (i + 0.5) / sb.n * W, y = H - 2 - cum[i] / mx * (H - 4); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    if (mark < sb.n) {
      g.globalAlpha = 0.25; g.beginPath();
      for (i = Math.max(0, mark); i < sb.n; i++) { var x2 = (i + 0.5) / sb.n * W, y2 = H - 2 - cum[i] / mx * (H - 4); if (i > mark) g.lineTo(x2, y2); else g.moveTo(x2, y2); }
      g.stroke(); g.globalAlpha = 1;
    }
  }

  /* ================================================================ the day timeline */

  var Day = { el: null, day: null, data: null, t: null, last: null, playing: false, raf: 0, open: false, lanes: false, req: 0, drag: false, timer: 0, err: null };
  var LS_OPEN = "cc.story.day.open", LS_LANES = "cc.story.day.lanes";

  function dayShell() {
    var el = document.createElement("section");
    el.className = "cc-dt";
    el.id = "cc-daytl";
    el.setAttribute("aria-label", "The day, replayed");
    el.setAttribute("data-cc-obstacle", "");
    el.innerHTML =
      '<button type="button" class="cc-dt-pill" data-dt="toggle" aria-expanded="false" aria-controls="cc-dt-bar">' + ic("replay") + '<span>Replay the day</span></button>' +
      '<div class="cc-dt-bar" id="cc-dt-bar" hidden>' +
      '<button type="button" class="cc-dt-b play" data-dt="play" aria-label="Play the day" title="Play (Space)">' + ic("play", "pl") + ic("pause", "pa") + "</button>" +
      '<div class="cc-dt-day"><button type="button" class="cc-dt-b sm" data-dt="prev" aria-label="The day before">' + ic("chevl") + '</button><b data-dt="daylab">Today</b><button type="button" class="cc-dt-b sm" data-dt="next" aria-label="The day after">' + ic("chevr") + "</button></div>" +
      '<div class="cc-dt-track" role="slider" tabindex="0" aria-label="Time of day"><canvas aria-hidden="true"></canvas><span class="cc-dt-nowline" aria-hidden="true"></span><span class="cc-dt-handle" aria-hidden="true"><i data-dt="at">now</i></span></div>' +
      '<button type="button" class="cc-dt-b" data-dt="lanes" aria-pressed="false" title="Each session\'s lane">' + ic("lanes") + "</button>" +
      '<button type="button" class="cc-dt-live" data-dt="live" title="Back to live">' + ic("live") + "<span>Now</span></button>" +
      '<button type="button" class="cc-dt-b" data-dt="close" aria-label="Hide the timeline">' + ic("close") + "</button>" +
      '<div class="cc-dt-lanes" data-dt="lanesbox" hidden></div>' +
      '<p class="cc-dt-note" data-dt="note" aria-live="polite"></p>' +
      "</div>";
    (document.getElementById("cc") || document.body).appendChild(el);
    el.addEventListener("click", dayClick);
    var tr = el.querySelector(".cc-dt-track");
    tr.addEventListener("pointerdown", function (e) { Day.drag = true; stopPlay(); tr.setPointerCapture(e.pointerId); seekFrom(e); });
    tr.addEventListener("pointermove", function (e) { if (Day.drag) seekFrom(e); else hoverAt(e); });
    tr.addEventListener("pointerleave", function () { tr.removeAttribute("title"); });
    tr.addEventListener("pointerup", function () { Day.drag = false; syncUrl(); });
    tr.addEventListener("pointercancel", function () { Day.drag = false; });
    tr.addEventListener("keydown", trackKey);
    window.addEventListener("resize", function () { if (Day.open) { placeDay(); drawDay(); } if (Story.el && !Story.el.hidden) { drawMoment(); drawTokSpark(Story.el.querySelector(".cc-st-tokspark")); } });
    document.addEventListener("joya-theme", function () { if (Day.open) drawDay(); if (Story.el && !Story.el.hidden) renderStory(); });
    return el;
  }
  function placeDay() {
    var el = Day.el; if (!el) return;
    var tb = document.querySelector(".topbar"), top = tb && tb.getBoundingClientRect().height ? tb.getBoundingClientRect().bottom + 8 : 24; // room for the time label above the handle
    el.style.top = Math.round(top) + "px";
    if (CC && CC.map && CC.map.resize && Day.open) CC.map.resize(); // the spheres keep clear of it (data-cc-obstacle)
  }
  function setOpen(on) {
    Day.open = !!on;
    var el = Day.el;
    el.classList.toggle("on", Day.open);
    el.querySelector(".cc-dt-bar").hidden = !Day.open;
    el.querySelector('[data-dt="toggle"]').hidden = Day.open;
    el.querySelector('[data-dt="toggle"]').setAttribute("aria-expanded", Day.open ? "true" : "false");
    try { localStorage.setItem(LS_OPEN, Day.open ? "1" : "0"); } catch (e) { /* no storage */ }
    if (!Day.open) { goLive(); }
    else { loadDay(Day.day); clearInterval(Day.timer); Day.timer = setInterval(function () { if (!document.hidden && Day.open && isToday()) loadDay(Day.day, true); }, 30000); }
    placeDay();
  }
  function isToday() { return Day.day === dayOf(Date.now(), TZ); }
  function loadDay(day, quiet) {
    day = day || dayOf(Date.now(), TZ);
    var n = ++Day.req;
    if (!quiet) note("Reading the day…");
    return api("story/day" + (day === dayOf(Date.now(), TZ) ? "" : "?day=" + encodeURIComponent(day))).then(function (r) {
      if (n !== Day.req) return;
      if (!r || !Array.isArray(r.sessions) || !r.from) { Day.err = "no day data"; note("JOYA AI's supervisor did not return the day"); return; }
      Day.day = r.day || day; Day.data = r; Day.err = null;
      if (Day.t != null && (Day.t < ms(r.from) || Day.t > ms(r.to))) Day.t = null;
      if (!isToday() && Day.t == null) Day.t = Math.min(ms(r.to) - 1, ms(r.from) + 12 * HOUR);
      note(summary());
      drawDay();
      applyReplay(false);
    }).catch(function (e) {
      if (n !== Day.req) return;
      Day.err = e && e.message ? e.message : String(e);
      note("Could not read the day: " + Day.err);
    });
  }
  function summary() {
    var d = Day.data; if (!d) return "";
    var s = (d.sessions || []).filter(function (x) { return !x.self; }).length;
    var del = (d.handoffs || []).filter(function (h) { return h.kind === "delegation"; }).length, msg = (d.handoffs || []).filter(function (h) { return h.kind === "message"; }).length;
    var ap = (d.approvals || []).length;
    return s + (s === 1 ? " session" : " sessions") + " worked · " + del + (del === 1 ? " delegation" : " delegations") + (msg ? " · " + msg + (msg === 1 ? " message between sessions" : " messages between sessions") : "") + " · " + ap + (ap === 1 ? " approval" : " approvals");
  }
  function note(t) { var n = Day.el && Day.el.querySelector('[data-dt="note"]'); if (n) n.textContent = t || ""; }
  /**
   * The stretch of the day the track shows: from the hour of the first activity to now (today) or to the
   * hour after the last activity (a past day) -- not the empty night. { a, b (latest moment), end (right edge), i0, i1 (bins) }.
   */
  function trackSpan() {
    var d = Day.data; if (!d) return null;
    var from = ms(d.from), to = ms(d.to), w = d.bin_ms || 300000, nowT = isToday() ? Date.now() : to;
    var first = null, last = null;
    (d.sessions || []).forEach(function (s) { var x = ms(s.first), y = ms(s.last); if (x != null && (first == null || x < first)) first = x; if (y != null && (last == null || y > last)) last = y; });
    var a = first == null ? from : Math.max(from, Math.floor(first / HOUR) * HOUR);
    var end = isToday() ? Math.min(to, Math.max(nowT + 10 * MIN, a + HOUR)) : first == null ? to : Math.min(to, Math.max(a + HOUR, Math.ceil(last / HOUR) * HOUR));
    var b = Math.min(nowT, end);
    return { a: a, b: b, end: end, i0: Math.floor((a - from) / w), i1: Math.ceil((end - from) / w) };
  }
  function seekFrom(e) {
    var sp = trackSpan(); if (!sp) return;
    seek(sp.a + fracAt(e) * (sp.end - sp.a), true);
  }
  function hoverAt(e) {
    var sp = trackSpan(); if (!sp) return;
    e.currentTarget.title = hmOf(sp.a + fracAt(e) * (sp.end - sp.a));
  }
  function trackKey(e) {
    var sp = trackSpan(); if (!sp) return;
    var cur = Day.t == null ? sp.b : Day.t, n = null, step = e.shiftKey ? HOUR : 5 * MIN;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") n = cur - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") n = cur + step;
    else if (e.key === "PageDown") n = cur - HOUR;
    else if (e.key === "PageUp") n = cur + HOUR;
    else if (e.key === "Home") n = sp.a;
    else if (e.key === "End") { e.preventDefault(); goLive(); return; }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
    if (n == null) return;
    e.preventDefault(); stopPlay(); seek(n);
  }
  /** Move the replay to t (ms). Past the present of today -> live. */
  function seek(t, quiet) {
    var sp = trackSpan(); if (!sp) return;
    if (isToday() && t >= Date.now() - 2 * MIN) { goLive(); return; }
    Day.t = Math.max(sp.a, Math.min(sp.end - 1, t));
    applyReplay(true);
    drawDay();
    if (!quiet) syncUrl();
  }
  /** Back to the live Command Center. */
  function goLive() {
    stopPlay();
    var was = Day.t != null;
    Day.t = null; Day.last = null;
    document.documentElement.classList.remove("cc-replaying");
    if (Day.el) Day.el.classList.remove("replay");
    if (was && CC && CC.resyncSessions) CC.resyncSessions();
    if (Day.data && !isToday()) { Day.day = dayOf(Date.now(), TZ); loadDay(Day.day, true); }
    drawDay();
    syncUrl();
  }
  /** The map at Day.t: the spheres as they were, and the hand-offs since the last moment as dot streams. */
  function applyReplay(streams) {
    var d = Day.data, t = Day.t;
    if (!d || t == null) { if (Day.el) Day.el.classList.remove("replay"); return; }
    document.documentElement.classList.add("cc-replaying");
    Day.el.classList.add("replay");
    var map = CC && CC.map;
    if (map && map.setNodes) map.setNodes(replayNodes(d, t, { headFor: headFor, hm: hmOf, max: phone() ? 5 : 8 }));
    if (map && streams && Day.last != null && t > Day.last && t - Day.last <= 45 * MIN) {
      var hs = between(d.handoffs, Day.last, t).slice(-3);
      hs.forEach(function (h) {
        if (h.kind === "delegation") { if (!(h.to_sid && map.send(h.to_sid, 2200)) && map.ghost) map.ghost(h.to || "a session", "not live then", 2000); }
        else if (h.kind === "reply") { if (h.from_sid && map.reply) map.reply(h.from_sid); }
        else if (h.kind === "message") { if (h.from_sid && h.to_sid && map.link) map.link(h.from_sid, h.to_sid); else if (h.to_sid) map.send(h.to_sid, 2200); }
      });
      if (hs.length) note(hmOf(hs[hs.length - 1].t) + " · " + hs[hs.length - 1].from + " → " + hs[hs.length - 1].to + ": " + clip(hs[hs.length - 1].text || "", 90));
    } else if (!streams) note(summary());
    Day.last = t;
  }
  function drawDay() {
    var el = Day.el, d = Day.data; if (!el || !Day.open) return;
    el.querySelector('[data-dt="daylab"]').textContent = d ? (isToday() ? "Today" : dayLabel(Day.day)) : "Today";
    el.querySelector('[data-dt="next"]').disabled = !d || isToday();
    el.querySelector('[data-dt="prev"]').disabled = !d || Date.now() - ms(d.from) > 13 * 24 * HOUR;
    el.querySelector('[data-dt="live"]').classList.toggle("on", Day.t == null);
    el.querySelector('[data-dt="live"]').setAttribute("aria-pressed", Day.t == null ? "true" : "false");
    el.querySelector('[data-dt="play"]').classList.toggle("on", Day.playing);
    el.querySelector('[data-dt="play"]').setAttribute("aria-label", Day.playing ? "Pause the replay" : "Play the day");
    var tr = el.querySelector(".cc-dt-track"), cv = tr.querySelector("canvas"), hd = tr.querySelector(".cc-dt-handle"), nl = tr.querySelector(".cc-dt-nowline");
    var sp = trackSpan();
    if (!d || !sp) { drawBars(cv, [], 1, cssVar("--accent", "#00a57a")); hd.hidden = true; nl.hidden = true; return; }
    var heat = dayHeat(d), w = d.bin_ms || 300000, n = sp.i1 - sp.i0;
    var cur = Day.t == null ? sp.b : Day.t, mark = Math.floor((cur - sp.a) / w);
    drawBars(cv, heat.total.slice(sp.i0, sp.i1), n, cssVar("--accent", "#00a57a"), mark);
    // the ticks: hand-offs (violet / joya) and approvals (amber) along the top
    var g = cv.getContext("2d"), W = cv.width / Math.min(window.devicePixelRatio || 1, 2), span_ = sp.end - sp.a;
    (d.handoffs || []).forEach(function (h) { var x = (ms(h.t) - sp.a) / span_ * W; g.fillStyle = h.kind === "reply" ? cssVar("--reply", "#6CC6FF") : cssVar("--violet-ink", "#B98CFF"); g.beginPath(); g.arc(x, 3.5, 2.2, 0, Math.PI * 2); g.fill(); });
    (d.approvals || []).forEach(function (a) { var x = (ms(a.t) - sp.a) / span_ * W; g.fillStyle = cssVar("--warn", "#F5B84A"); g.fillRect(x - 1, 0, 2, 7); });
    var k = (cur - sp.a) / span_;
    hd.hidden = false; atFrac(hd, k);
    el.querySelector('[data-dt="at"]').textContent = Day.t == null ? "now" : hmOf(Day.t);
    nl.hidden = !isToday(); atFrac(nl, (Date.now() - sp.a) / span_);
    tr.setAttribute("aria-valuemin", String(sp.a)); tr.setAttribute("aria-valuemax", String(sp.end)); tr.setAttribute("aria-valuenow", String(Math.round(cur)));
    tr.setAttribute("aria-valuetext", (Day.t == null ? "now, live" : hmOf(cur)) + ", " + (isToday() ? "today" : dayLabel(Day.day)));
    drawLanes();
  }
  function drawLanes() {
    var box = Day.el.querySelector('[data-dt="lanesbox"]'), d = Day.data;
    box.hidden = !Day.lanes;
    Day.el.querySelector('[data-dt="lanes"]').setAttribute("aria-pressed", Day.lanes ? "true" : "false");
    if (!Day.lanes || !d) return;
    var list = (d.sessions || []).slice(0, phone() ? 6 : 10), sp = trackSpan(), n = d.bins || 288, nv = sp.i1 - sp.i0;
    var sig = Day.day + "|" + list.map(function (s) { return s.session_id + ":" + s.records; }).join(",");
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = list.map(function (s) {
        return '<button type="button" class="cc-dt-lane' + (s.self ? " self" : "") + '" data-dt-lane="' + esc(s.session_id) + '" title="Open the story of ' + esc(s.name) + '">' +
          '<canvas class="hd" aria-hidden="true"></canvas><span class="nm">' + esc(clip(s.name, 28)) + '</span><canvas class="ht" aria-hidden="true"></canvas><span class="tk">' + esc(fmtTok(s.tokens)) + "</span></button>";
      }).join("") + ((d.sessions || []).length > list.length ? '<p class="cc-dt-more">and ' + ((d.sessions || []).length - list.length) + " more</p>" : "");
      box.querySelectorAll(".cc-dt-lane").forEach(function (b, i) {
        var s = list[i];
        paintHead(b.querySelector("canvas.hd"), s.self ? (document.getElementById("cc") || document.body).getAttribute("data-bot-head") || "cap" : headFor(s), "idle", 22);
      });
    }
    var cur = Day.t == null ? sp.b : Day.t, mark = Math.floor((cur - sp.a) / (d.bin_ms || 300000));
    box.querySelectorAll(".cc-dt-lane").forEach(function (b, i) {
      var s = list[i], h = laneHeat(s, n);
      drawBars(b.querySelector("canvas.ht"), h.v.slice(sp.i0, sp.i1), nv, s.self ? cssVar("--violet-ink", "#B98CFF") : cssVar("--accent", "#00a57a"), mark);
      var bi = mark + sp.i0;
      b.classList.toggle("now", (s.bins || []).some(function (x) { return x[0] === bi || x[0] === bi - 1; }));
    });
  }
  function dayClick(e) {
    var lane = e.target.closest("[data-dt-lane]");
    if (lane) { open(lane.getAttribute("data-dt-lane"), Day.t); return; }
    var b = e.target.closest("[data-dt]"); if (!b) return;
    var a = b.getAttribute("data-dt");
    if (a === "toggle") setOpen(true);
    else if (a === "close") setOpen(false);
    else if (a === "live") goLive();
    else if (a === "play") togglePlay();
    else if (a === "lanes") { Day.lanes = !Day.lanes; try { localStorage.setItem(LS_LANES, Day.lanes ? "1" : "0"); } catch (x) { /* no storage */ } drawDay(); placeDay(); }
    else if (a === "prev" || a === "next") { stopPlay(); var nd = shiftDay(Day.day || dayOf(Date.now(), TZ), a === "prev" ? -1 : 1); Day.t = null; Day.last = null; if (nd === dayOf(Date.now(), TZ)) { Day.day = nd; goLive(); loadDay(nd); } else { Day.day = nd; loadDay(nd); } }
  }
  function togglePlay() { if (Day.playing) stopPlay(); else startPlay(); }
  function startPlay() {
    var sp = trackSpan(); if (!sp) return;
    if (Day.t == null) Day.t = firstActive() || sp.a;
    Day.playing = true; Day.last = Day.t;
    var lastF = 0, acc = 0;
    // 20 minutes of the day per second; reduced motion: one 5-minute step every quarter second.
    function frame(now) {
      if (!Day.playing) return;
      var dt = lastF ? Math.min(100, now - lastF) : 16; lastF = now;
      var next;
      if (reduced) { acc += dt; if (acc < 250) { Day.raf = requestAnimationFrame(frame); return; } acc = 0; next = Day.t + 5 * MIN; }
      else next = Day.t + dt * 20 * MIN / 1000;
      var stop = isToday() ? Date.now() : sp.end - 1;
      if (next >= stop) { if (isToday()) { goLive(); } else { Day.t = stop; stopPlay(); applyReplay(true); drawDay(); } return; }
      Day.t = next; applyReplay(true); drawDay();
      Day.raf = requestAnimationFrame(frame);
    }
    Day.raf = requestAnimationFrame(frame);
    drawDay();
  }
  function stopPlay() { if (!Day.playing) return; Day.playing = false; cancelAnimationFrame(Day.raf); drawDay(); syncUrl(); }
  function firstActive() {
    var d = Day.data, best = null;
    (d.sessions || []).forEach(function (s) { var a = ms(s.first); if (a != null && (best == null || a < best)) best = a; });
    return best;
  }
  /** Open the timeline at t (ms / ISO; null: live). */
  function replay(t) {
    if (!Day.el) Day.el = dayShell();
    var x = ms(t);
    if (!Day.open) setOpen(true);
    if (x == null) { goLive(); return; }
    var dd = dayOf(x, TZ);
    if (dd !== Day.day || !Day.data) { Day.day = dd; Day.t = x; Day.last = null; loadDay(dd); }
    else seek(x);
  }

  /* ================================================================ wiring */

  function attach(cc, panels) {
    CC = cc; P = panels;
    if (CC && CC.TZ) TZ = CC.TZ;
    if (!Day.el) Day.el = dayShell();
    var open_ = false;
    try { open_ = localStorage.getItem(LS_OPEN) === "1"; Day.lanes = localStorage.getItem(LS_LANES) === "1"; } catch (e) { /* no storage */ }
    var link = parseLink(location.search);
    if (link.session) setTimeout(function () { open(link.session, link.t); }, 0);
    else if (link.t != null) setTimeout(function () { replay(link.t); }, 0);
    else if (open_) setOpen(true);
    placeDay();
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && Story.el && !Story.el.hidden && !e.defaultPrevented) { e.preventDefault(); close(); }
    }, true);
  }

  window.JoyaStory = {
    L: L,
    attach: attach,
    /** Open a session's story at t (ms, ISO, Date; null or omitted: live). false if the id is not a session id. */
    open: function (sid, t) { return open(sid, t); },
    /** For the Command Center: open the story for a sphere / list key when it is a session id (else false: the old deep view). */
    openKey: function (key) { var s = CC && CC.findSess ? CC.findSess(key) : null; var sid = (s && s.session_id) || (UUID_RE.test(String(key)) ? String(key) : null); return sid ? open(sid, Day.t, { key: key }) : false; },
    close: close,
    /** A link into a session's story at a moment: "/joya-ai?session=…&t=…" (t optional). */
    link: function (sid, t) { return linkFor("/joya-ai", "", sid, t); },
    /** The day timeline at t (null: live). */
    replay: replay,
    live: function () { goLive(); },
    /** True while the day timeline is replaying a past moment (the Command Center then leaves the spheres to it). */
    replaying: function () { return Day.t != null; },
    /** The moment shown: { session, t } (t null = live). */
    at: function () { return { session: Story.el && !Story.el.hidden ? Story.sid : null, t: Story.el && !Story.el.hidden ? Story.t : Day.t }; },
  };
})();
