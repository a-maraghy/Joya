"use strict";
/*
 * The living canvas (2026-10-20): the Command Center as a board JOYA AI arranges moment to moment.
 * The page's half, in the browser Command Center and the desktop app's render mode (?shell=desktop).
 *
 *   - Widgets: JOYA AI's answers may carry one (its MCP ui_widget -> the supervisor -> server.js
 *     uiDeliver, which checks it again and asks lib/routes-canvas.js whether the person still wants that
 *     kind). joya-ai.js hands the "ui" event here (JoyaCanvas.offer); it is checked a third time
 *     (JoyaWidgets.validate) and drawn beside the reply. Pin keeps it on the board (the server stores
 *     it), the size button cycles S / M / L, × dismisses it. All of it counts toward what is learned.
 *   - Building blocks only: every block is drawn with createElement + textContent (charts are SVG built
 *     node by node). Nothing from a widget is ever parsed as markup, and no widget can name a URL.
 *   - Sources: a block with a view reads the widget's source -- the dashboard's existing read-only routes
 *     (/joya-ai/api/cost, /caps, /sessions/:id/story) or the page's own live state (sessions, the feed,
 *     approvals) -- and stays live: fetched sources refresh every 30 s while shown, the page's own state
 *     on every tick.
 *   - Layout: JoyaCanvasPolicy.plan() decides from the moment (a failing or long-waiting session is
 *     the hero, with its error and "Fix it", which sends JOYA AI an ordinary request through the
 *     composer's own send; a fresh morning brief takes the centre; calm is the core and a few quiet
 *     tiles). The core stays the hero: the centre slot sits under it, in the page's column, so the core
 *     shrinks a little to make room (cc-map resizes from its stage). Changes move with a FLIP animation;
 *     reduced motion moves nothing. Lock keeps the arrangement as it is (Settings ▸ Appearance ▸ Board).
 *   - Desktop app: the board is a column beside the core, opposite the glance cards; every card is a hit
 *     region and a glass surface (joya-desktop.js HIT / GLASS), and blur follows only once a card holds still.
 *
 *   window.JoyaCanvas = { offer(ev), state, plan(), refresh(), pin(id), dismiss(id), size(id, s), lock(on) }
 */
(function () {
  var cc = document.getElementById("cc");
  if (!cc) return;
  var MW = window.JoyaWidgets, POL = window.JoyaCanvasPolicy;
  if (!MW || !POL) return;
  var DESK = cc.getAttribute("data-shell") === "desktop";
  var CSRF = cc.getAttribute("data-csrf") || "";
  var TICK_MS = 1000, FETCH_TTL = 30000, ANIM_MS = 320;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var SVGNS = "http://www.w3.org/2000/svg";

  // The default quiet tiles (calm): today's spend, the sessions, the approvals.
  var QUIET = {
    "metric:usage.spend": { v: 1, kind: "metric", title: "Spend today", source: { name: "usage.spend" }, size: "s", blocks: [{ type: "metric", view: "today" }] },
    "metric:sessions": { v: 1, kind: "metric", title: "Sessions", source: { name: "sessions" }, size: "s", blocks: [{ type: "metric", view: "working" }, { type: "metric", view: "waiting" }] },
    "metric:approvals": { v: 1, kind: "metric", title: "Approvals", source: { name: "approvals" }, size: "s", blocks: [{ type: "metric", view: "count" }] },
  };

  var C = {
    loaded: false, prefs: { locked: false, learn: true }, pins: [], learned: { standing: [], suppressed: [] },
    offered: [],          // { id, spec, key, turn, at }
    hidden: {},           // standing tiles put away on this page
    acked: readAcked(),   // incidents put away (this browser)
    waitSeen: {},         // session key -> when this page first saw it waiting (no status_since)
    data: {},             // source cache: key -> { at, data, err, busy }
    plan: null, sig: "", fix: null,
  };

  /* ---------------------------------------------------------------- small helpers */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function svg(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k])); return e; }
  function mcc() { return window.__joyaCC || null; }
  function reduced() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function small() { return !DESK && window.innerWidth <= 720; }
  function now() { var c = mcc(); return c && c.now ? c.now() : Date.now(); }
  function readAcked() { try { var v = JSON.parse(window.localStorage.getItem("joya-canvas-acked") || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
  function saveAcked() { try { window.localStorage.setItem("joya-canvas-acked", JSON.stringify(C.acked)); } catch (e) { /* this page only */ } }
  function api(path, body) {
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.headers["X-CSRF-Token"] = CSRF; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || "HTTP " + r.status); e.status = r.status; throw e; } return j; });
    });
  }
  function count(key, what) { api("/joya-ai/api/canvas/event", { key: key, what: what }).then(takeLearned, function () { /* a count lost is fine */ }); }
  function takeLearned(j) { if (j && j.learned) { C.learned = j.learned; schedule(); } }
  function tok(n) { return window.JoyaGlance ? window.JoyaGlance.tok(n) : String(Math.round(n)); }
  function fmt(v, f) {
    if (typeof v !== "number") return v == null ? "" : String(v);
    switch (f) {
      case "usd": return "$" + (Math.abs(v) < 100 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US"));
      case "tokens": return tok(v);
      case "pct": return Math.round(v) + " %";
      case "count": case "number": return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100);
      case "minutes": case "duration": return dur(v * (f === "minutes" ? 60e3 : 1));
      case "time": return hm(v);
      default: return String(v);
    }
  }
  function dur(ms) { ms = Math.max(0, ms || 0); var m = Math.round(ms / 60e3); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0"); }
  // Times as the Command Center shows them (joya-ai.js TZ: Cairo), so a widget's time matches its reply's.
  var HM = null;
  try { HM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo" }); } catch (e) { HM = null; }
  function hm(t) { var d = new Date(t); if (isNaN(d)) return ""; return HM ? HM.format(d) : String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function clip(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* ---------------------------------------------------------------- sources */
  var FETCHED = {
    "usage.spend": function () { return "/joya-ai/api/cost"; },
    "usage.caps": function () { return "/joya-ai/api/caps"; },
    story: function (p) { return UUID.test(p.session) ? "/joya-ai/api/sessions/" + p.session + "/story" : null; },
  };
  function srcKey(s) { return s.name + (s.params && s.params.session ? ":" + s.params.session : "") + (s.params && s.params.state ? ":" + s.params.state : ""); }
  /** The source's data now: { data } or { wait } or { err }. Fetched ones are cached and refreshed while shown. */
  function sourceData(s) {
    var c = mcc();
    if (!FETCHED[s.name]) {
      if (!c || !c.S) return { wait: true };
      return { data: c.S };
    }
    var k = srcKey(s), e = C.data[k] || (C.data[k] = { at: 0, data: null, err: null, busy: false });
    if (!e.busy && now() - e.at > FETCH_TTL) {
      var url = FETCHED[s.name](s.params || {});
      if (url) {
        e.busy = true;
        api(url).then(function (j) { e.data = j; e.err = null; }, function (x) { e.err = x.message || "not available"; }).then(function () { e.busy = false; e.at = now(); schedule(true); });
      } else e.err = "no such session";
    }
    if (e.data) return { data: e.data };
    if (e.err) return { err: e.err };
    return { wait: true };
  }
  function sessionsOf(S) { return (S.sessions || []).filter(function (s) { return !s.self && !(window.JoyaGlance && window.JoyaGlance.isAiName(s.name)); }); }
  function sState(s) { return s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle"; }
  function sKey(s) { return String(s.session_id || s.pid || s.name); }
  function pendingOf(S) { var out = []; if (S.approvals && S.approvals.forEach) S.approvals.forEach(function (a) { if (a.status === "pending") out.push(a); }); return out; }

  /** A view of a source, as the block it feeds. */
  function view(source, v, d) {
    var p = source.params || {};
    switch (source.name + "." + v) {
      case "usage.spend.days":
        return { type: "chart", style: "bar", unit: "usd", stacked: true, series: [
          { label: "JOYA AI", points: (d.days || []).map(function (x) { return [String(x.day).slice(5), x.joya_ai_usd || 0]; }) },
          { label: "Other sessions (est.)", points: (d.days || []).map(function (x) { return [String(x.day).slice(5), x.others_usd_est || 0]; }) },
        ] };
      case "usage.spend.today": {
        var t = d.today || {};
        return { type: "metric", label: "Spend today", value: t.total_usd || 0, unit: "usd", hint: "JOYA AI " + fmt(t.joya_ai_usd || 0, "usd") + " · others ≈ " + fmt(t.others_usd_est || 0, "usd") };
      }
      case "usage.spend.sessions":
        return { type: "table", columns: [{ key: "name", label: "Session" }, { key: "today", label: "Today", align: "right", format: "usd" }, { key: "week", label: "7 days", align: "right", format: "usd" }],
          rows: (d.sessions || []).slice(0, 12).map(function (s) { return { name: s.name, today: s.today_usd || 0, week: (s.week || []).reduce(function (a, b) { return a + b; }, 0) }; }) };
      case "usage.spend.top":
        return { type: "list", items: (d.sessions || []).filter(function (s) { return s.today_usd > 0; }).slice(0, 5).map(function (s) { return { text: s.name, sub: fmt(s.today_usd, "usd") + " today" + (s.estimated ? " (est.)" : ""), session: UUID.test(s.session_id) ? s.session_id : undefined }; }) };
      case "usage.caps.tokens": {
        var g = window.JoyaGlance ? window.JoyaGlance.cost(d, null) : { total: 0, capText: "" };
        return { type: "metric", label: "Tokens today", value: g.total || 0, unit: "tokens", hint: g.capText || "", tone: g.tone === "over" ? "err" : g.tone === "near" ? "warn" : "" };
      }
      case "usage.caps.tightest": {
        var g2 = window.JoyaGlance ? window.JoyaGlance.cost(d, null) : { pct: null };
        return { type: "metric", label: "Nearest a cap", value: g2.pct == null ? "no cap" : Math.round(g2.pct * 100), unit: g2.pct == null ? "" : "pct", hint: g2.capText || "", tone: g2.tone === "over" ? "err" : g2.tone === "near" ? "warn" : "ok" };
      }
      case "usage.caps.sessions":
        return { type: "table", columns: [{ key: "name", label: "Session" }, { key: "tok", label: "Today", align: "right", format: "tokens" }, { key: "cap", label: "Cap", align: "right", format: "tokens" }, { key: "pct", label: "Used", align: "right", format: "pct" }],
          rows: (d.sessions || []).map(function (s) { var t = (s.today && s.today.total) || 0; return { name: s.kind === "self" ? "JOYA AI" : s.name, tok: t, cap: s.cap || "—", pct: s.cap ? (100 * t) / s.cap : "—" }; }) };
      case "usage.caps.chart":
        return { type: "chart", style: "bar", unit: "tokens", series: [{ label: "Tokens today", points: (d.sessions || []).map(function (s) { return [clip(s.kind === "self" ? "JOYA AI" : s.name, 16), (s.today && s.today.total) || 0]; }) }] };
      case "sessions.list": case "sessions.table": case "sessions.working": case "sessions.waiting": {
        var list = sessionsOf(d);
        if (v === "working" || v === "waiting") return { type: "metric", label: v === "working" ? "Working" : "Waiting on you", value: list.filter(function (s) { return sState(s) === v; }).length, unit: "count", tone: v === "waiting" && list.some(function (s) { return sState(s) === "waiting"; }) ? "warn" : "" };
        if (p.state && p.state !== "any") list = list.filter(function (s) { return sState(s) === p.state; });
        if (v === "table") return { type: "table", columns: [{ key: "name", label: "Session" }, { key: "state", label: "State" }, { key: "where", label: "Where" }], rows: list.slice(0, 20).map(function (s) { return { name: s.name, state: sState(s) + (s.status_since ? " · " + hm(s.status_since) : ""), where: s.where || "" }; }) };
        return { type: "list", items: list.slice(0, 12).map(function (s) { var st = sState(s); return { text: s.name || "A session", sub: st === "waiting" ? (s.waiting_for ? "waiting for " + s.waiting_for : "waiting on you") : st, tone: st === "waiting" ? "warn" : st === "working" ? "ok" : "", session: UUID.test(String(s.session_id)) ? s.session_id : undefined }; }) };
      }
      case "story.files": return { type: "files", files: (d.files || []).slice(0, 40).map(function (f) { return { path: f.path, add: f.add || 0, del: f.del || 0 }; }) };
      case "story.tokens": return { type: "metric", label: "Tokens", value: (d.tokens && d.tokens.total) || 0, unit: "tokens", hint: d.turns ? d.turns + " turns" : "" };
      case "story.active": return { type: "metric", label: "Active time", value: dur(d.time && d.time.active_ms), hint: d.time && d.time.first ? "since " + hm(d.time.first) : "" };
      case "story.steps": return { type: "list", items: ((d.plan && d.plan.steps) || []).slice(-8).map(function (s) { return { text: s.title, sub: s.status, tone: s.status === "done" ? "ok" : s.status === "now" ? "info" : s.status === "failed" ? "err" : "" }; }) };
      case "story.handoffs": return { type: "list", items: (d.handoffs || []).slice(-6).reverse().map(function (h) { return { text: (h.from || "") + " → " + (h.to || ""), sub: clip(h.text, 110) + " · " + hm(h.t) }; }) };
      case "feed.alerts": return { type: "list", items: (window.JoyaGlance ? window.JoyaGlance.alerts(d.feed || [], now(), 6) : []).map(function (a) { return { text: a.text, sub: a.ago, tone: a.tone }; }) };
      case "feed.recent": return { type: "list", items: (d.feed || []).slice(0, 6).map(function (f) { return { text: clip(window.JoyaGlance ? window.JoyaGlance.plain(f.html) : "", 150), sub: hm(f.ts) }; }) };
      case "approvals.pending": {
        var ap = window.JoyaGlance ? window.JoyaGlance.approvals(pendingOf(d), now()) : { list: [] };
        return { type: "list", items: ap.list.map(function (a) { return { text: a.what, sub: a.who + (a.leftText ? " · " + a.leftText + " left" : ""), tone: a.low ? "err" : "warn" }; }) };
      }
      case "approvals.count": { var n = pendingOf(d).length; return { type: "metric", label: "Waiting on you", value: n, unit: "count", tone: n ? "warn" : "ok" }; }
    }
    return null;
  }

  /* ---------------------------------------------------------------- drawing the blocks (text only, never markup) */
  function drawBlock(b, w, box) {
    var src = w.source || null, d;
    if (b.view) {
      var r = sourceData(src);
      if (r.wait) return box.appendChild(el("p", "cv-wait", "Reading " + src.name + "…"));
      if (r.err) return box.appendChild(el("p", "cv-err", "Not available: " + r.err));
      d = view(src, b.view, r.data);
      if (!d) return box.appendChild(el("p", "cv-err", "Nothing to show."));
      if (b.label) d.label = b.label;
      if (b.style) d.style = b.style;
    } else d = b;
    switch (d.type) {
      case "text": { var p = el("p", "cv-text" + (d.tone ? " t-" + d.tone : ""), d.text); box.appendChild(p); return; }
      case "metric": return drawMetric(d, box);
      case "chart": return drawChart(d, box);
      case "table": return drawTable(d, box);
      case "list": return drawList(d, box, w);
      case "files": return drawFiles(d, box);
      case "story": return drawStory(d.session, box, w);
      case "compare": return drawCompare(d.sessions, box, w);
      case "approval": return drawApproval(d.approval, box, w);
    }
  }
  function drawMetric(d, box) {
    var m = el("div", "cv-metric" + (d.tone ? " t-" + d.tone : ""));
    m.appendChild(el("span", "cv-m-l", d.label));
    m.appendChild(el("b", "cv-m-v", typeof d.value === "number" ? fmt(d.value, d.unit || "number") : d.value));
    if (d.hint) m.appendChild(el("small", "cv-m-h", d.hint));
    box.appendChild(m);
  }
  function drawChart(d, box) {
    var series = d.series || [], n = 0;
    series.forEach(function (s) { n = Math.max(n, s.points.length); });
    if (!n) return box.appendChild(el("p", "cv-wait", "No points."));
    var Wd = 300, H = 110, pad = 4, max = 0;
    var stack = d.style !== "line" && series.length > 1;
    for (var i = 0; i < n; i++) {
      var tot = 0;
      series.forEach(function (s) { var y = s.points[i] ? Math.max(0, s.points[i][1]) : 0; if (stack) tot += y; else max = Math.max(max, y); });
      if (stack) max = Math.max(max, tot);
    }
    if (!(max > 0)) max = 1;
    var g = svg("svg", { viewBox: "0 0 " + Wd + " " + H, class: "cv-chart", role: "img", preserveAspectRatio: "none" });
    var label = (series.map(function (s) { return s.label; }).join(", ")) + ": up to " + fmt(max, d.unit || "number");
    g.setAttribute("aria-label", label);
    var bw = (Wd - pad * 2) / n;
    if (d.style === "line") {
      series.forEach(function (s, k) {
        var pts = s.points.map(function (pt, j) { return (pad + bw * (j + 0.5)).toFixed(1) + "," + (H - pad - ((H - pad * 2) * Math.max(0, pt[1])) / max).toFixed(1); }).join(" ");
        g.appendChild(svg("polyline", { points: pts, class: "cv-s" + k, fill: "none" }));
      });
    } else {
      for (var j = 0; j < n; j++) {
        var base = H - pad;
        series.forEach(function (s, k) {
          var pt = s.points[j];
          if (!pt) return;
          var h = ((H - pad * 2) * Math.max(0, pt[1])) / max;
          var x = pad + bw * j + (stack ? bw * 0.14 : (bw * 0.14) + (bw * 0.72 * k) / series.length);
          var wdt = stack ? bw * 0.72 : (bw * 0.72) / series.length;
          var r = svg("rect", { x: x.toFixed(1), y: (stack ? base - h : H - pad - h).toFixed(1), width: Math.max(1, wdt).toFixed(1), height: Math.max(0.5, h).toFixed(1), rx: 1.5, class: "cv-s" + k });
          var t = svg("title", {}); t.textContent = s.label + " · " + pt[0] + ": " + fmt(pt[1], d.unit || "number");
          r.appendChild(t);
          g.appendChild(r);
          if (stack) base -= h;
        });
      }
    }
    var wrap = el("div", "cv-chartbox");
    wrap.appendChild(g);
    var ax = el("div", "cv-axis");
    var first = series[0].points[0], last = series[0].points[series[0].points.length - 1];
    ax.appendChild(el("span", null, first ? first[0] : ""));
    ax.appendChild(el("span", "cv-max", "max " + fmt(max, d.unit || "number")));
    ax.appendChild(el("span", null, last ? last[0] : ""));
    wrap.appendChild(ax);
    if (series.length > 1) {
      var lg = el("div", "cv-legend");
      series.forEach(function (s, k) { var it = el("span", "cv-lg"); it.appendChild(el("i", "cv-s" + k)); it.appendChild(document.createTextNode(s.label)); lg.appendChild(it); });
      wrap.appendChild(lg);
    }
    box.appendChild(wrap);
  }
  function drawTable(d, box) {
    var sc = el("div", "cv-tscroll");
    var t = el("table", "cv-table"), th = el("thead"), tr = el("tr");
    d.columns.forEach(function (c) { var h = el("th", c.align === "right" ? "n" : null, c.label); h.scope = "col"; tr.appendChild(h); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el("tbody");
    if (!d.rows.length) { var e = el("tr"), td = el("td", "cv-wait", "No rows."); td.colSpan = d.columns.length; e.appendChild(td); tb.appendChild(e); }
    d.rows.forEach(function (r) {
      var row = el("tr");
      d.columns.forEach(function (c) { row.appendChild(el("td", c.align === "right" ? "n" : null, fmt(r[c.key], c.format))); });
      tb.appendChild(row);
    });
    t.appendChild(tb); sc.appendChild(t); box.appendChild(sc);
  }
  function drawList(d, box, w) {
    var ul = el("ul", "cv-list");
    if (!d.items.length) ul.appendChild(el("li", "cv-wait", "Nothing right now."));
    d.items.forEach(function (it) {
      var li = el("li", it.tone ? "t-" + it.tone : null);
      li.appendChild(el("i"));
      var body = el("div");
      if (it.session && window.JoyaStory) {
        var b = el("button", "cv-link", it.text);
        b.type = "button";
        b.title = "Open its story";
        b.addEventListener("click", function () { opened(w); window.JoyaStory.open(it.session, null); });
        body.appendChild(b);
      } else body.appendChild(el("span", "cv-li-t", it.text));
      if (it.sub) body.appendChild(el("small", null, it.sub));
      li.appendChild(body);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  function drawFiles(d, box) {
    var ul = el("ul", "cv-files");
    var max = 1;
    d.files.forEach(function (f) { max = Math.max(max, f.add + f.del); });
    var ta = 0, td = 0;
    d.files.forEach(function (f) {
      ta += f.add; td += f.del;
      var li = el("li");
      var p = el("span", "cv-path", "\u200e" + f.path + "\u200e"); // marks keep the slashes where they belong in the right-to-left clipping box
      p.title = f.path;
      li.appendChild(p);
      li.appendChild(el("span", "cv-add", "+" + f.add));
      li.appendChild(el("span", "cv-del", "−" + f.del));
      var bar = el("span", "cv-fbar");
      var a = el("i", "a"), r = el("i", "d");
      a.style.width = ((100 * f.add) / max).toFixed(1) + "%";
      r.style.width = ((100 * f.del) / max).toFixed(1) + "%";
      bar.appendChild(a); bar.appendChild(r); li.appendChild(bar);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.appendChild(el("small", "cv-sum", d.files.length + " file" + (d.files.length === 1 ? "" : "s") + " · +" + ta + " −" + td));
  }
  function storyOf(sid) { return sourceData({ name: "story", params: { session: sid } }); }
  function drawStory(sid, box, w) {
    var r = storyOf(sid);
    if (r.wait) return box.appendChild(el("p", "cv-wait", "Reading the session's story…"));
    if (r.err) return box.appendChild(el("p", "cv-err", "Not available: " + r.err));
    var d = r.data, s = d.session || {};
    var card = el("div", "cv-story");
    var hd = el("div", "cv-st-h");
    hd.appendChild(el("b", null, s.name || "A session"));
    hd.appendChild(el("span", "cv-chip st-" + (s.state || "idle"), s.state === "waiting" && s.waiting_for ? "waiting for " + s.waiting_for : s.state || "idle"));
    card.appendChild(hd);
    var steps = (d.plan && d.plan.steps) || [];
    var nowStep = steps.filter(function (x) { return x.status === "now"; })[0] || steps[steps.length - 1];
    if (nowStep) card.appendChild(el("p", "cv-st-now", (nowStep.status === "now" ? "Now: " : "Last: ") + nowStep.title));
    var rail = el("div", "cv-rail");
    steps.slice(-10).forEach(function (x) { var i = el("i", "s-" + x.status); i.title = x.title + " · " + x.status; rail.appendChild(i); });
    if (steps.length) card.appendChild(rail);
    var f = el("div", "cv-st-f");
    f.appendChild(el("span", null, (d.files || []).length + " files · +" + ((d.file_totals && d.file_totals.add) || 0) + " −" + ((d.file_totals && d.file_totals.del) || 0)));
    f.appendChild(el("span", null, tok((d.tokens && d.tokens.total) || 0) + " tokens"));
    f.appendChild(el("span", null, dur(d.time && d.time.active_ms) + " active"));
    card.appendChild(f);
    if (window.JoyaStory) {
      var b = el("button", "cv-b", "Open the story");
      b.type = "button";
      b.addEventListener("click", function () { opened(w); window.JoyaStory.open(sid, null); });
      card.appendChild(b);
    }
    box.appendChild(card);
  }
  function drawCompare(ids, box, w) {
    var a = storyOf(ids[0]), b = storyOf(ids[1]);
    if (a.wait || b.wait) return box.appendChild(el("p", "cv-wait", "Reading both sessions…"));
    var rows = [["Tokens", function (d) { return (d.tokens && d.tokens.total) || 0; }, "tokens"], ["Active", function (d) { return (d.time && d.time.active_ms) || 0; }, "duration"],
      ["Files", function (d) { return (d.files || []).length; }, "count"], ["Lines +/−", function (d) { return ((d.file_totals && d.file_totals.add) || 0) + ((d.file_totals && d.file_totals.del) || 0); }, "count"], ["Turns", function (d) { return d.turns || 0; }, "count"]];
    var t = el("table", "cv-table cv-cmp"), th = el("thead"), tr = el("tr");
    tr.appendChild(el("th"));
    [a, b].forEach(function (x, k) {
      var h = el("th", "n");
      h.scope = "col";
      if (x.err) h.textContent = "—";
      else if (window.JoyaStory) { var lb = el("button", "cv-link", (x.data.session && x.data.session.name) || "Session"); lb.type = "button"; lb.addEventListener("click", function () { opened(w); window.JoyaStory.open(ids[k], null); }); h.appendChild(lb); }
      else h.textContent = (x.data.session && x.data.session.name) || "Session";
      tr.appendChild(h);
    });
    th.appendChild(tr); t.appendChild(th);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      row.appendChild(el("th", null, r[0]));
      var va = a.err ? null : r[1](a.data), vb = b.err ? null : r[1](b.data);
      [va, vb].forEach(function (v, k) { var c = el("td", "n" + (v != null && v === Math.max(va || 0, vb || 0) && va !== vb ? " hi" : ""), v == null ? "—" : fmt(v, r[2])); row.appendChild(c); if (k === 1) {} });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    box.appendChild(t);
  }
  function drawApproval(id, box, w) {
    var c = mcc(), S = c && c.S;
    var a = S && S.approvals && S.approvals.get ? S.approvals.get(id) || S.approvals.get(String(id)) : null;
    var card = el("div", "cv-ap");
    if (!a) { card.appendChild(el("p", "cv-wait", "That approval is not here (it may have been decided).")); box.appendChild(card); return; }
    var g = window.JoyaGlance ? window.JoyaGlance.approvals([a], now()).list[0] : null;
    card.appendChild(el("span", "cv-ap-k", a.status === "pending" ? "Needs you · approval" : "Approval · " + a.status));
    card.appendChild(el("b", null, (g && g.what) || a.summary || a.tool || "A step"));
    card.appendChild(el("small", null, ((g && g.who) || "JOYA AI") + (g && g.leftText ? " · " + g.leftText + " left" : "")));
    if (a.status === "pending") {
      var row = el("div", "cv-ap-b");
      var mk = function (txt, cls, fn) { var b = el("button", "cv-b" + (cls ? " " + cls : ""), txt); b.type = "button"; b.addEventListener("click", function () { opened(w); fn(); }); row.appendChild(b); };
      // The existing decision card and its approve path (step-up on the server): never a new one.
      mk("Review", "", function () { c.openNeed(a.id); });
      if (c.approve) mk("Approve", "pri", function () { c.approve(a.id); });
      if (c.decide) mk("Deny", "", function () { c.decide(a.id, "deny"); });
      card.appendChild(row);
    }
    box.appendChild(card);
  }
  function opened(w) { if (w && w.key) count(w.key, "open"); }

  /* ---------------------------------------------------------------- the widget card */
  var SIZE_NEXT = { s: "m", m: "l", l: "s" };
  function card(t, spec) {
    var w = el("section", "cv-w cv-k-" + spec.kind + (t.quiet ? " quiet" : "") + (t.type === "offered" ? " offered" : ""));
    w.setAttribute("data-cv", t.id);
    w.setAttribute("data-size", t.size);
    if (t.type !== "history") w.setAttribute("data-cc-obstacle", ""); // in the conversation sheet it is no obstacle
    w.setAttribute("aria-label", spec.title);
    if (spec.blocks[0] && spec.blocks[0].type === "approval") w.classList.add("cv-ap-w");
    var hd = el("header", "cv-h");
    var tt = el("div", "cv-t");
    tt.appendChild(el("b", null, spec.title));
    var meta = t.type === "offered" ? "From JOYA AI's answer · " + hm(t.at) : t.type === "history" ? "Shown with this reply" + (t.at ? " · " + hm(t.at) : "") : t.type === "standing" ? (t.learned ? "You keep this one" : "") : "";
    if (spec.source) meta = (meta ? meta + " · " : "") + "live";
    if (meta) tt.appendChild(el("small", spec.source ? "live" : null, meta));
    hd.appendChild(tt);
    var acts = el("div", "cv-acts");
    var btn = function (act, label, txt) { var b = el("button", "cv-ib", txt); b.type = "button"; b.setAttribute("data-cv-act", act); b.setAttribute("aria-label", label); b.title = label; acts.appendChild(b); return b; };
    if (t.type === "offered" || t.type === "history") btn("pin", "Pin to the board", "Pin");
    if (t.type === "pinned" || t.type === "offered") btn("size", "Size: " + t.size.toUpperCase() + " (change)", t.size.toUpperCase());
    if (t.type === "pinned") btn("unpin", "Unpin", "Unpin");
    if (t.type !== "history") btn("x", t.type === "pinned" ? "Unpin and dismiss" : "Dismiss", "×");
    hd.appendChild(acts);
    w.appendChild(hd);
    var bd = el("div", "cv-bd");
    var blocks = t.size === "s" ? spec.blocks.slice(0, spec.kind === "metric" ? 2 : 1) : spec.blocks;
    blocks.forEach(function (b) { drawBlock(b, { key: t.key, source: spec.source }, bd); });
    w.appendChild(bd);
    if (spec.note && t.size !== "s") w.appendChild(el("p", "cv-note", spec.note));
    return w;
  }
  /** The hero session card: its error, Fix it, its story, put it away. */
  function heroCard(h) {
    var w = el("section", "cv-w cv-hero-s");
    w.setAttribute("data-cv", "hero:" + h.id);
    w.setAttribute("data-size", "l");
    w.setAttribute("data-cc-obstacle", "");
    w.setAttribute("role", "region");
    w.setAttribute("aria-label", h.name + " needs you");
    var hd = el("header", "cv-h");
    var tt = el("div", "cv-t");
    tt.appendChild(el("span", "cv-ap-k " + (h.reason === "waiting" ? "warn" : "err"), h.reason === "waiting" ? "Waiting on you" : h.reason === "held" ? "Held" : "Failed"));
    tt.appendChild(el("b", null, h.name));
    hd.appendChild(tt);
    var acts = el("div", "cv-acts");
    var x = el("button", "cv-ib", "×"); x.type = "button"; x.setAttribute("data-cv-act", "ack"); x.setAttribute("aria-label", "Put it away"); x.title = "Put it away";
    acts.appendChild(x); hd.appendChild(acts);
    w.appendChild(hd);
    var bd = el("div", "cv-bd");
    var at = h.at ? (h.reason === "waiting" ? "since " + hm(h.at) + " (" + dur(now() - h.at) + ")" : "at " + hm(h.at)) : "";
    bd.appendChild(el("p", "cv-error", (h.text || (h.reason === "waiting" ? "It is waiting on you." : "Its work did not finish.")) + (at ? " — " + at : "")));
    var row = el("div", "cv-ap-b");
    var fix = el("button", "cv-b pri", "Fix it"); fix.type = "button"; fix.setAttribute("data-cv-act", "fix");
    row.appendChild(fix);
    var sess = sessionByKey(h.key);
    if (sess && UUID.test(String(sess.session_id)) && window.JoyaStory) { var st = el("button", "cv-b", "Its story"); st.type = "button"; st.setAttribute("data-cv-act", "story"); row.appendChild(st); }
    else if (sess) { var op = el("button", "cv-b", "Open it"); op.type = "button"; op.setAttribute("data-cv-act", "open"); row.appendChild(op); }
    bd.appendChild(row);
    if (C.fix && C.fix.id === h.id) {
      var fx = el("div", "cv-fix");
      fx.appendChild(el("small", null, "Send this to JOYA AI (it goes through the usual flow: delegation, and your approval for anything destructive):"));
      fx.appendChild(el("p", "cv-fix-t", C.fix.text));
      var r2 = el("div", "cv-ap-b");
      var s1 = el("button", "cv-b pri", "Send"); s1.type = "button"; s1.setAttribute("data-cv-act", "fix-send");
      var s2 = el("button", "cv-b", "Edit first"); s2.type = "button"; s2.setAttribute("data-cv-act", "fix-edit");
      var s3 = el("button", "cv-b", "Cancel"); s3.type = "button"; s3.setAttribute("data-cv-act", "fix-cancel");
      r2.appendChild(s1); r2.appendChild(s2); r2.appendChild(s3);
      fx.appendChild(r2);
      bd.appendChild(fx);
    }
    w.appendChild(bd);
    return w;
  }
  function fixText(h) {
    if (h.reason === "waiting") return "Fix it: " + h.name + " has been waiting on me " + dur(now() - h.at) + " (" + (h.text || "waiting") + "). Find out what it needs and get it moving -- delegate to it, and ask me for anything that needs my approval.";
    return "Fix it: the work sent to " + h.name + " " + (h.reason === "held" ? "is held" : "failed") + (h.text ? " (" + clip(h.text, 200) + ")" : "") + ". Find the cause and delegate the fix to " + h.name + " (or whoever owns it); ask me before anything destructive.";
  }
  function sessionByKey(k) { var c = mcc(); if (!c || !c.S) return null; return (c.S.sessions || []).filter(function (s) { return sKey(s) === String(k) || s.session_id === k || s.name === k; })[0] || null; }

  /* ---------------------------------------------------------------- the facts, the plan */
  function facts() {
    var c = mcc(), S = (c && c.S) || {};
    var t = now();
    var sessions = sessionsOf(S).map(function (s) {
      var st = sState(s), k = sKey(s);
      if (st === "waiting") { if (!C.waitSeen[k]) C.waitSeen[k] = t; } else delete C.waitSeen[k];
      var since = s.status_since ? Date.parse(s.status_since) : st === "waiting" ? C.waitSeen[k] : NaN;
      return { key: k, name: s.name, state: st, since: since, waiting_for: s.waiting_for || null };
    });
    var failures = [];
    if (S.delegations && S.delegations.forEach) S.delegations.forEach(function (d) {
      if (d.status !== "failed" && d.status !== "held") return;
      var s = (S.sessions || []).filter(function (x) { return (d.target_session && x.session_id === d.target_session) || x.name === d.target_name; })[0];
      failures.push({ id: d.id, key: s ? sKey(s) : d.target_name, name: d.target_name || d.target || "A session", at: d.updated_at || d.failed_at || d.created_at, status: d.status, text: d.note || d.summary || "" });
    });
    failures.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
    var card = window.JoyaProactive && window.JoyaProactive.current ? window.JoyaProactive.current() : null;
    // The person's hour: in their brief's time zone (Settings > Briefs & watchers), else this device's.
    var hour = new Date(t).getHours();
    var tz = window.JoyaProactive && window.JoyaProactive.state && window.JoyaProactive.state.prefs && window.JoyaProactive.state.prefs.tz;
    if (tz) { try { hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(t))) % 24; } catch (e) { /* this device's */ } }
    return {
      now: t, hour: hour, small: small(),
      brief: card && !DESK ? { id: card.id, kind: card.kind, at: Date.parse(card.created_at) } : null,
      sessions: sessions, failures: failures, acked: C.acked,
      pinned: C.pins.map(function (p) { return { id: "p" + p.id, key: p.key, size: p.size }; }),
      offered: C.offered.map(function (o) { return { id: o.id, key: o.key }; }),
      standing: (C.learned.standing || []).map(function (s) { return s.key; }).filter(function (k) { return !C.hidden["std:" + k]; }),
      // The desktop app's glance cards already show the sessions, today's tokens and the approvals: no quiet tiles there.
      quiet: deskGlance() ? [] : Object.keys(QUIET).filter(function (k) { return !C.hidden["std:" + k]; }),
      locked: !!C.prefs.locked,
    };
  }
  function deskGlance() { var D = DESK && window.JoyaDesktop; var g = D && D.glance ? D.glance() : null; return !!(g && g.on); }
  function specFor(t) {
    if (t.type === "offered") { var o = C.offered.filter(function (x) { return x.id === t.id; })[0]; return o ? { spec: o.spec, at: o.at } : null; }
    if (t.type === "pinned") { var p = C.pins.filter(function (x) { return "p" + x.id === t.id; })[0]; return p ? { spec: p.spec } : null; }
    if (t.type === "standing") {
      var l = (C.learned.standing || []).filter(function (x) { return x.key === t.key; })[0];
      if (l) return { spec: l.spec, learned: true };
      return QUIET[t.key] ? { spec: QUIET[t.key] } : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- the DOM: columns, the centre slot, the control */
  var board = el("div", "cv-board");
  board.id = "cv-board";
  var left = el("div", "cv-col cv-left"), right = el("div", "cv-col cv-right");
  left.id = "cv-left"; right.id = "cv-right";
  board.appendChild(left); board.appendChild(right);
  cc.appendChild(board);
  var centre = el("div", "cv-centre");
  centre.id = "cv-centre";
  var main = $("cc-center"), cap = $("cc-caption");
  if (!DESK && main && cap) main.insertBefore(centre, cap);
  else board.appendChild(centre);
  var ctl = el("div", "cv-ctl");
  ctl.id = "cv-ctl";
  ctl.setAttribute("data-cc-obstacle", "");
  cc.appendChild(ctl);

  var renderAt = 0, pending = false, force = false;
  function schedule(f) { if (f) force = true; if (pending) return; pending = true; (window.requestAnimationFrame || setTimeout)(function () { pending = false; render(); }); }

  function render() {
    if (!C.loaded || !mcc()) return;
    // Companion mode out on the desk (joya-desktop-companion.js): only the bot shows, so the board rests --
    // nothing is drawn or measured; the first tick after the Command Center opens again redraws it whole.
    if (DESK && document.documentElement.classList.contains("dk-comp-out")) { force = true; return; }
    var plan = POL.plan(facts());
    C.plan = plan;
    cc.setAttribute("data-cv-mode", plan.mode);
    // The page state a widget shows changes every tick: redraw when the plan or the data moved.
    var dataSig = dataSignature(plan);
    paintHistory(false);
    var sig = JSON.stringify(plan) + "|" + dataSig + "|" + (C.fix ? C.fix.id : "") + "|" + window.innerWidth + "x" + window.innerHeight;
    if (!force && sig === C.sig) { placeDesk(); return; }
    force = false;
    C.sig = sig;
    var before = rects();
    var hadCentre = centre.getBoundingClientRect().height;
    [left, right, centre].forEach(function (c) { while (c.firstChild) { if (c.firstChild.id === "pa-card") cc.appendChild(c.firstChild); else c.removeChild(c.firstChild); } });
    // The hero
    if (plan.hero && plan.hero.type === "session") centre.appendChild(heroCard(plan.hero));
    if (plan.hero && plan.hero.type === "brief") { var pa = $("pa-card"); if (pa) { pa.classList.add("cv-in-centre"); centre.appendChild(pa); } }
    var pa2 = $("pa-card");
    if (pa2 && !(plan.hero && plan.hero.type === "brief")) pa2.classList.remove("cv-in-centre");
    // The tiles
    var tray = null;
    plan.tiles.forEach(function (t) {
      var node;
      if (t.type === "incident") node = incidentChip(t);
      else { var s = specFor(t); if (!s) return; t.at = s.at; t.learned = s.learned; node = card(t, s.spec); }
      if (t.slot === "centre") centre.appendChild(node);
      else if (t.slot === "tray") { if (!tray) { tray = el("div", "cv-tray"); centre.appendChild(tray); } tray.appendChild(node); }
      else (t.slot === "left" ? left : right).appendChild(node);
    });
    centre.classList.toggle("on", !!centre.firstChild);
    paintCtl(plan);
    columns();
    animate(before);
    var nowCentre = centre.getBoundingClientRect().height;
    if (Math.abs(nowCentre - hadCentre) > 1) coreFollow();
    placeDesk();
  }
  function incidentChip(t) {
    var w = el("section", "cv-w cv-inc");
    w.setAttribute("data-cv", t.id);
    w.setAttribute("data-size", "s");
    w.setAttribute("data-cc-obstacle", "");
    var b = el("button", "cv-inc-b");
    b.type = "button";
    b.setAttribute("data-cv-act", "inc-open");
    b.setAttribute("data-key", String(t.key || ""));
    b.appendChild(el("i", t.reason === "waiting" ? "warn" : "err"));
    b.appendChild(el("b", null, t.name));
    b.appendChild(el("small", null, t.reason === "waiting" ? "waits on you" : t.reason === "held" ? "held" : "failed"));
    w.appendChild(b);
    return w;
  }
  function dataSignature(plan) {
    return specsSignature(plan.tiles.map(function (t) { return specFor(t); }));
  }
  /** What the given widgets show, as a string: it changes when their sources' data does. */
  function specsSignature(list) {
    var c = mcc(), S = (c && c.S) || {}, parts = [];
    list.forEach(function (s) {
      if (!s || !s.spec) return;
      var src = s.spec.source;
      if (src && FETCHED[src.name]) { var e = C.data[srcKey(src)]; parts.push(e ? e.at + (e.err || "") : "-"); }
      s.spec.blocks.forEach(function (b) {
        if (b.type === "story") { var e2 = C.data["story:" + b.session]; parts.push(e2 ? e2.at : "-"); }
        if (b.type === "compare") b.sessions.forEach(function (x) { var e3 = C.data["story:" + x]; parts.push(e3 ? e3.at : "-"); });
      });
      if (src && !FETCHED[src.name] || s.spec.blocks.some(function (b) { return b.type === "approval"; })) {
        parts.push((S.sessions || []).map(function (x) { return x.name + x.status; }).join(","));
        parts.push(S.feed && S.feed[0] ? S.feed[0].key + S.feed.length : "");
        var ap = []; if (S.approvals && S.approvals.forEach) S.approvals.forEach(function (a) { ap.push(a.id + a.status); });
        parts.push(ap.join(","));
        if (s.spec.blocks.some(function (b) { return b.type === "approval"; })) parts.push(Math.floor(now() / 15000));
      }
    });
    return parts.join("|");
  }
  function paintCtl(plan) {
    while (ctl.firstChild) ctl.removeChild(ctl.firstChild);
    var lock = el("button", "cv-lock" + (plan.locked ? " on" : ""));
    lock.type = "button";
    lock.setAttribute("data-cv-act", "lock");
    lock.setAttribute("aria-pressed", String(!!plan.locked));
    lock.title = plan.locked ? "The board is locked: it stays as arranged. Click to let it follow the moment." : "The board follows the moment (" + plan.why + "). Click to lock it as it is.";
    lock.appendChild(el("i", "cv-lk"));
    lock.appendChild(el("span", null, plan.locked ? "Board locked" : modeLabel(plan.mode)));
    ctl.appendChild(lock);
    if (plan.locked && plan.attention.length) {
      var a = el("button", "cv-att");
      a.type = "button";
      a.setAttribute("data-cv-act", "att");
      a.textContent = plan.attention.length + (plan.attention.length === 1 ? " needs you" : " need you");
      a.title = plan.attention.map(function (x) { return x.name || x.reason; }).join(", ");
      ctl.appendChild(a);
    }
  }
  function modeLabel(m) { return m === "incident" ? "Board · something needs you" : m === "brief" ? "Board · morning" : m === "board" ? "Board · your widgets" : "Board · calm"; }

  /** Side columns: below the brief card (left) and the decision card (right), clear of the composer; overflow folds to "+N". */
  function columns() {
    if (DESK) return;
    var top = (document.querySelector(".topbar") || { getBoundingClientRect: function () { return { bottom: 56 }; } }).getBoundingClientRect().bottom + 16;
    var pa = $("pa-card"), need = $("cc-need");
    var lt = top, rt = top;
    if (pa && !pa.classList.contains("cv-in-centre") && pa.getClientRects().length) lt = pa.getBoundingClientRect().bottom + 12;
    if (need && !need.hidden && need.getClientRects().length) rt = need.getBoundingClientRect().bottom + 12;
    var dock = $("cc-dock"), bottom = dock ? dock.getBoundingClientRect().top - 12 : window.innerHeight - 140;
    if (window.innerWidth > 1180) bottom = window.innerHeight - 24; // wide: the composer is narrower than the gap between the columns
    left.style.top = Math.round(lt) + "px"; right.style.top = Math.round(rt) + "px";
    left.style.maxHeight = Math.max(0, Math.round(bottom - lt)) + "px"; right.style.maxHeight = Math.max(0, Math.round(bottom - rt)) + "px";
    [left, right].forEach(function (col) {
      var more = 0, lim = col.getBoundingClientRect().top + parseFloat(col.style.maxHeight || "0");
      Array.prototype.forEach.call(col.children, function (n) { n.hidden = false; });
      Array.prototype.forEach.call(col.children, function (n) { if (n.getBoundingClientRect().bottom > lim + 1) { n.hidden = true; more++; } });
      if (more) { var m = el("div", "cv-more", "+" + more + " more"); col.appendChild(m); if (m.getBoundingClientRect().bottom > lim + 1 && col.children.length > 1) { var last = col.children[col.children.length - 2]; last.hidden = true; m.textContent = "+" + (more + 1) + " more"; } }
    });
  }

  /* The desktop app: one column beside the core, opposite the glance cards; in Floating, the headroom above the box. */
  function placeDesk() {
    if (!DESK) return;
    var D = window.JoyaDesktop, L = D && D.layout ? D.layout() : null;
    if (!L) return;
    var st = D.state ? D.state() : {};
    right.hidden = true;
    var col = left, x, y, w, h;
    if (L.mode === "floating") {
      var need = $("cc-need");
      w = L.card.w; x = L.card.x;
      if (L.card.bottom != null) { y = 8; h = L.H - L.card.bottom - 8; }
      else { y = L.card.y; h = L.card.h; }
      board.classList.toggle("cv-under", !!(need && !need.hidden) || !!st.focus);
    } else {
      var gl = L.glance;
      var side = gl ? (gl.side === "left" ? "right" : "left") : L.cx > L.W / 2 ? "left" : "right";
      w = Math.min(280, L.W - 32);
      x = side === "right" ? Math.min(L.W - 16 - w, L.cx + L.R + 48) : Math.max(16, L.cx - L.R - 48 - w);
      y = Math.max(16, L.cy - L.R);
      if (side === "right" && L.card) { var nd = $("cc-need"); if (nd && !nd.hidden && nd.getClientRects().length) y = Math.max(y, nd.getBoundingClientRect().bottom + 12); }
      h = L.H - y - 16;
      board.classList.toggle("cv-under", !!st.focus);
    }
    // Everything of the board goes into the one column: the hero first.
    [centre, right].forEach(function (c) { while (c.firstChild) { var n = c.firstChild; if (n.id === "pa-card") { cc.appendChild(n); continue; } col.insertBefore(n, c === centre ? col.firstChild : null); } });
    var sig = [x, y, w, h].map(Math.round).join(",");
    if (col.getAttribute("data-place") !== sig) {
      col.setAttribute("data-place", sig);
      col.style.left = Math.round(x) + "px"; col.style.top = Math.round(y) + "px"; col.style.width = Math.round(w) + "px"; col.style.maxHeight = Math.max(0, Math.round(h)) + "px";
    }
    var lim = y + h, more = 0;
    Array.prototype.forEach.call(col.children, function (n) { if (!n.classList.contains("cv-more")) n.hidden = false; });
    Array.prototype.forEach.call(col.children, function (n) { if (!n.classList.contains("cv-more") && n.getBoundingClientRect().bottom > lim + 1) { n.hidden = true; more++; } });
    Array.prototype.forEach.call(col.querySelectorAll(".cv-more"), function (n) { n.remove(); });
    if (more) col.appendChild(el("div", "cv-more", "+" + more + " more"));
  }

  /* ---------------------------------------------------------------- motion: FLIP, and the core following the centre */
  function rects() {
    var m = {};
    Array.prototype.forEach.call(document.querySelectorAll("#cv-board .cv-w, #cv-centre .cv-w"), function (n) { m[n.getAttribute("data-cv")] = n.getBoundingClientRect(); });
    return m;
  }
  function animate(before) {
    if (reduced() || !Element.prototype.animate) return;
    Array.prototype.forEach.call(document.querySelectorAll("#cv-board .cv-w, #cv-centre .cv-w"), function (n) {
      var id = n.getAttribute("data-cv"), a = before[id], b = n.getBoundingClientRect();
      if (!b.width) return;
      if (!a) { n.animate([{ opacity: 0, transform: "translateY(8px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: ANIM_MS, easing: "cubic-bezier(.2,.8,.2,1)" }); return; }
      var dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      n.animate([{ transformOrigin: "top left", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" }, { transformOrigin: "top left", transform: "none" }], { duration: ANIM_MS, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  }
  var following = 0;
  function coreFollow() {
    var c = mcc(), o = c && c.orbit;
    if (!o || !o.resize) return;
    if (reduced()) { o.resize(); return; }
    var t0 = Date.now(), id = ++following;
    (function step() {
      if (id !== following) return;
      o.resize();
      if (Date.now() - t0 < ANIM_MS + 80) window.requestAnimationFrame(step);
    })();
  }

  /* ---------------------------------------------------------------- what the person does */
  function onClick(e) {
    var b = e.target.closest ? e.target.closest("[data-cv-act]") : null;
    if (!b) return;
    var act = b.getAttribute("data-cv-act");
    var w = b.closest(".cv-w");
    var id = w ? w.getAttribute("data-cv") : null;
    var t = C.plan ? C.plan.tiles.filter(function (x) { return x.id === id; })[0] : null;
    if (act === "lock") return lock(!C.prefs.locked);
    if (act === "att") { var a = C.plan && C.plan.attention[0]; if (a && a.key) openSess(a.key); return; }
    if (act === "inc-open") return openSess(b.getAttribute("data-key"));
    var hero = C.plan && C.plan.hero;
    if (act === "ack" && hero) { C.acked[hero.id] = Date.now(); saveAcked(); C.fix = null; return schedule(true); }
    if (act === "fix" && hero) { C.fix = { id: hero.id, text: fixText(hero) }; schedule(true); return; }
    if (act === "fix-cancel") { C.fix = null; return schedule(true); }
    if (act === "fix-send" && C.fix) { var c = mcc(); if (c && c.send) c.send(C.fix.text); C.fix = null; if (hero) { C.acked[hero.id] = Date.now(); saveAcked(); } return schedule(true); }
    if (act === "fix-edit" && C.fix) { var inp = $("cc-input"); if (inp) { inp.value = C.fix.text; inp.focus(); } C.fix = null; return schedule(true); }
    if (act === "story" && hero) { var s = sessionByKey(hero.key); if (s && window.JoyaStory) window.JoyaStory.open(s.session_id, null); return; }
    if (act === "open" && hero) return openSess(hero.key);
    if (!t) return;
    if (act === "pin") return pin(t.id);
    if (act === "size") return size(t.id, SIZE_NEXT[t.size] || "m");
    if (act === "unpin") return unpin(t.id, false);
    if (act === "x") return dismiss(t.id);
  }
  function openSess(key) { var c = mcc(), s = sessionByKey(key); if (s && UUID.test(String(s.session_id)) && window.JoyaStory) window.JoyaStory.open(s.session_id, null); else if (c && c.openSession) c.openSession(key); }
  function pin(id) {
    var o = C.offered.filter(function (x) { return x.id === id; })[0];
    if (!o) return Promise.resolve(false);
    return api("/joya-ai/api/canvas/pin", { widget: o.spec, size: o.size || o.spec.size }).then(function (j) {
      C.offered = C.offered.filter(function (x) { return x !== o; });
      C.pins.push(j.pin);
      takeLearned(j);
      schedule(true);
      return true;
    }, function (e) { toast("Not pinned: " + e.message); return false; });
  }
  function unpin(id, dismissed) {
    var p = C.pins.filter(function (x) { return "p" + x.id === id; })[0];
    if (!p) return Promise.resolve(false);
    C.pins = C.pins.filter(function (x) { return x !== p; });
    schedule(true);
    return api("/joya-ai/api/canvas/pins/" + p.id + "/unpin", {}).then(function (j) { takeLearned(j); return true; }, function () { return false; });
  }
  function size(id, s) {
    var p = C.pins.filter(function (x) { return "p" + x.id === id; })[0];
    if (p) { p.size = s; schedule(true); return api("/joya-ai/api/canvas/pins/" + p.id + "/size", { size: s }).catch(function () { /* kept here */ }); }
    var o = C.offered.filter(function (x) { return x.id === id; })[0];
    if (o) { o.size = s; schedule(true); }
    return Promise.resolve();
  }
  function dismiss(id) {
    var t = C.plan ? C.plan.tiles.filter(function (x) { return x.id === id; })[0] : null;
    if (!t) return;
    if (t.type === "offered") { C.offered = C.offered.filter(function (x) { return x.id !== id; }); count(t.key, "dismiss"); }
    else if (t.type === "pinned") return unpin(id, true);
    else if (t.type === "standing") { C.hidden[id] = 1; count(t.key, "dismiss"); }
    schedule(true);
  }
  function lock(on) {
    C.prefs.locked = !!on;
    schedule(true);
    return api("/joya-ai/api/canvas/prefs", { locked: !!on }).then(function (j) { C.prefs = j.prefs; schedule(true); }, function () { /* kept here */ });
  }
  function toast(text) { var c = mcc(); if (c && c.toast) c.toast(text); }

  /** JOYA AI's widget for this tab (joya-ai.js hands the "ui" event here): { ok } or { ok: false, why }. */
  function offer(ev) {
    var v = MW.validate(ev && ev.widget);
    if (!v.ok) return { ok: false, why: "not a widget: " + v.why };
    if ((C.learned.suppressed || []).indexOf(v.key) >= 0) return { ok: false, why: "the administrator keeps dismissing widgets of this kind; answer in words" };
    var id = "o" + String(ev.nonce || Date.now()).slice(0, 24);
    if (C.offered.some(function (x) { return x.id === id; })) return { ok: false, why: "already shown" };
    C.offered.unshift({ id: id, spec: v.value, key: v.key, turn: ev.turn_id || null, at: Date.now(), size: v.value.size });
    C.offered = C.offered.slice(0, POL.POLICY.MAX_OFFERED + 2);
    if (window.JoyaSound && window.JoyaSound.play) window.JoyaSound.play("done", { role: "core" });
    schedule(true);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- the conversation's widgets (history)
     A widget JOYA AI showed is kept with its reply in the supervisor's ledger (the conversation's own store)
     and comes back with the turn: after a reload, in another tab, on another device. joya-ai.js hands each
     painted turn here; every widget is checked again before it is drawn, live sources refresh as usual, and
     it is shown whatever the learning says (it was offered then). Pin puts it on the board. */
  var hist = []; // { box, turn, items: [{ id, at, spec, key }], sig }
  function history(turnEl, tr) {
    var items = [];
    (tr.widgets || []).slice(0, 3).forEach(function (w) {
      var v = w && MW.validate(w.widget);
      if (v && v.ok) items.push({ id: "h" + tr.id + ":" + String(w.id || "").slice(0, 24), at: Date.parse(w.at) || null, spec: v.value, key: v.key });
    });
    if (!items.length) return;
    var host = turnEl.querySelector(".cc-msg.ai .cc-bubble") || turnEl;
    var box = el("div", "cv-hist");
    box.setAttribute("data-turn", String(tr.id));
    host.appendChild(box);
    hist = hist.filter(function (h) { return h.box.isConnected && h.turn !== tr.id; });
    var h = { box: box, turn: tr.id, items: items, sig: "" };
    hist.push(h);
    drawHistory(h);
  }
  function drawHistory(h) {
    h.sig = specsSignature(h.items);
    while (h.box.firstChild) h.box.removeChild(h.box.firstChild);
    h.items.forEach(function (it) {
      var t = { id: it.id, type: "history", key: it.key, size: "m", at: it.at };
      h.box.appendChild(card(t, it.spec));
    });
  }
  function paintHistory(all) {
    hist = hist.filter(function (h) { return h.box.isConnected; });
    hist.forEach(function (h) { if (all || specsSignature(h.items) !== h.sig) drawHistory(h); });
  }
  function onHistClick(e) {
    var b = e.target.closest ? e.target.closest("[data-cv-act]") : null;
    if (!b || !b.closest(".cv-hist")) return;
    var w = b.closest(".cv-w"), id = w && w.getAttribute("data-cv");
    var it = null;
    hist.forEach(function (h) { h.items.forEach(function (x) { if (x.id === id) it = x; }); });
    if (!it) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.getAttribute("data-cv-act") === "pin") {
      api("/joya-ai/api/canvas/pin", { widget: it.spec, size: it.spec.size }).then(function (j) {
        C.pins.push(j.pin);
        takeLearned(j);
        b.textContent = "Pinned";
        b.disabled = true;
        schedule(true);
      }, function (x) { toast("Not pinned: " + x.message); });
    }
  }
  document.addEventListener("click", onHistClick, true);

  board.addEventListener("click", onClick);
  centre.addEventListener("click", onClick);
  ctl.addEventListener("click", onClick);
  window.addEventListener("resize", function () { schedule(true); });
  document.addEventListener("joya-proactive", function () { schedule(true); });

  function load() {
    return api("/joya-ai/api/canvas").then(function (j) {
      C.prefs = j.prefs || C.prefs;
      C.pins = j.pins || [];
      C.learned = j.learned || C.learned;
      C.loaded = true;
      schedule(true);
    }, function () { C.loaded = true; schedule(true); });
  }
  // Wait for the Command Center (joya-ai.js) to be up: it is loaded after this file.
  (function wait(n) { if (mcc()) return load(); if (n < 200) setTimeout(function () { wait(n + 1); }, 50); })(0);
  setInterval(function () { if (!document.hidden || DESK) render(); }, TICK_MS);

  window.JoyaCanvas = {
    offer: offer, history: history, state: C, plan: function () { return C.plan; }, refresh: function () { schedule(true); }, reload: load,
    pin: pin, dismiss: dismiss, size: size, lock: lock, QUIET: QUIET,
  };
})();
