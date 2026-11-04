"use strict";
/*
 * The JOYA AI desktop app's glance cards (0.1.9), the pure part: what the four
 * cards beside the core say, from what the Command Center already holds --
 * shared by the page (public/joya-desktop.js draws them) and the tests
 * (tools/test-desktop-glance.cjs).
 *
 *   approvals(list, now)        pending approvals, the one that runs out first on top
 *   sessions(list)              working / waiting on you / idle counts, and the 2-3 names that matter
 *   cost(caps, status)          today's tokens against the tightest daily cap (Settings > Usage, token caps)
 *   alerts(feed, now, max)      the recent events that matter, from the Command Center's own event log
 *
 * Nothing here talks to the server or touches the page. Every string it returns
 * is plain text; the page escapes it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JoyaGlance = api;
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_APPROVALS = 2; // shown as cards; the rest are "+N more"
  var MAX_NAMES = 3;
  var ALERT_MAX = 4;
  var ALERT_WINDOW_MS = 12 * 3600 * 1000;

  function str(s) { return s == null ? "" : String(s); }
  function clip(s, n) { s = str(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /** JOYA AI by any of its names (JOYA AI, JOYA AI, JOYA Bot), as joya-ai.js isAiName. */
  function isAiName(n) {
    var k = str(n).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    return k === "joya ai" || k === "joya ai" || k === "joya bot";
  }
  /** A session's key, as joya-ai.js sessKey: the page opens a session by it. */
  function sessKey(s) { return String(s.session_id || s.pid || s.name); }
  function sessState(s) { return s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle"; }

  /** "1.2M", "840k", "312". */
  function tok(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  /** "now", "4 min", "2 h", "yesterday". */
  function ago(ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (ms < 45e3) return "now";
    if (ms < 3600e3) return Math.round(ms / 60e3) + " min";
    if (ms < 24 * 3600e3) return Math.round(ms / 3600e3) + " h";
    return "yesterday";
  }
  /** "4:05". */
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

  /* ---------------------------------------------------------------- approvals */
  function approvals(list, now) {
    var out = [];
    (list || []).forEach(function (a) {
      if (!a || a.status !== "pending" || !a.id) return;
      var exp = Date.parse(a.expires_at), left = isFinite(exp) ? Math.max(0, (exp - now) / 1000) : null;
      var who = /^session:/.test(str(a.origin)) ? str(a.origin_name || a.origin.slice(8)) : "JOYA AI";
      out.push({ id: Number(a.id), who: who, what: clip(a.summary || a.tool || "A step", 140), label: clip(a.label || "", 60), left: left, leftText: left == null ? "" : mmss(left), low: left != null && left < 60, exp: isFinite(exp) ? exp : Infinity });
    });
    out.sort(function (x, y) { return x.exp - y.exp || x.id - y.id; });
    return { list: out.slice(0, MAX_APPROVALS), more: Math.max(0, out.length - MAX_APPROVALS), total: out.length };
  }

  /* ---------------------------------------------------------------- sessions */
  function sessions(list) {
    var c = { working: 0, waiting: 0, idle: 0 }, live = [];
    (list || []).forEach(function (s) {
      if (!s || s.self || isAiName(s.name)) return;
      var st = sessState(s);
      c[st]++;
      live.push({ s: s, st: st });
    });
    // What matters first: the ones waiting on you, then the ones at work (the most active first), then idle.
    var rank = { waiting: 0, working: 1, idle: 2 };
    live.sort(function (a, b) {
      return rank[a.st] - rank[b.st] || ((b.s.tokens_today && b.s.tokens_today.total) || 0) - ((a.s.tokens_today && a.s.tokens_today.total) || 0) || str(a.s.name).localeCompare(str(b.s.name));
    });
    var top = live.filter(function (x) { return x.st !== "idle"; }).slice(0, MAX_NAMES);
    if (!top.length) top = live.slice(0, Math.min(2, MAX_NAMES));
    return {
      working: c.working, waiting: c.waiting, idle: c.idle, total: live.length,
      top: top.map(function (x) {
        var note = x.st === "waiting" ? (x.s.waiting_for ? "waiting for " + clip(x.s.waiting_for, 40) : "waiting on you") : x.st === "working" ? "working" : "idle";
        return { key: sessKey(x.s), name: clip(x.s.name || "A session", 40), state: x.st, note: note };
      }),
    };
  }

  /* ---------------------------------------------------------------- today's tokens */
  /**
   * caps: the supervisor's token-caps view ({ sessions: [{ key, name, kind, cap, today: { total }, state }], warn_pct }),
   * or null before it came; status: the Command Center's status (tokens_today for JOYA AI, cost_today in $).
   * The bar is the session nearest its cap (the one that pauses or warns first).
   */
  function cost(caps, status) {
    var st = status || {}, rows = (caps && caps.sessions) || [];
    var total = 0, tight = null;
    rows.forEach(function (r) {
      var t = (r.today && Number(r.today.total)) || 0;
      total += t;
      if (r.cap > 0) {
        var pct = t / r.cap;
        if (!tight || pct > tight.pct) tight = { name: r.kind === "self" ? "JOYA AI" : clip(r.name || r.key, 28), used: t, cap: r.cap, pct: pct, state: r.state, at: r.at };
      }
    });
    if (!rows.length && st.tokens_today && st.tokens_today.total != null) total = Number(st.tokens_today.total) || 0;
    var usd = st.cost_today && Number(st.cost_today.total_usd);
    var out = { total: total, totalText: tok(total), known: !!(caps || (st.tokens_today && st.tokens_today.total != null)), usd: usd > 0 ? usd : null, usdText: usd > 0 ? "≈ $" + (usd < 10 ? usd.toFixed(2) : Math.round(usd)) : "" };
    if (tight) {
      var warn = ((caps && caps.warn_pct) || 80) / 100;
      out.pct = Math.min(1, tight.pct);
      out.tone = tight.state === "paused" || tight.pct >= 1 ? "over" : tight.state === "near" || tight.pct >= warn ? "near" : "ok";
      out.capText = tight.name + " " + tok(tight.used) + " of " + tok(tight.cap) + " · " + Math.round(tight.pct * 100) + "%";
      out.stateText = tight.state === "paused" ? "paused at its cap" : tight.pct >= 1 ? "at its cap" : out.tone === "near" ? "near its cap" : "";
    } else {
      out.pct = null;
      out.tone = "none";
      out.capText = caps ? "No daily cap set" : "";
      out.stateText = "";
    }
    return out;
  }

  /* ---------------------------------------------------------------- alerts */
  function plain(html) {
    return str(html).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }
  function boldOf(html) { var m = /<b>([\s\S]*?)<\/b>/.exec(str(html)); return m ? plain(m[1]) : ""; }
  /**
   * feed: the Command Center's event log (S.feed: { key, ts, kind, html }, newest first).
   * Kept: approvals asked for and decided, errors, warnings (a session waiting on you, a failed
   * service), a session done (its idle message) or ended, a watcher that fired, a brief written.
   * Left out: replies, notices, sessions starting.
   */
  function alerts(feed, now, max) {
    var out = [];
    (feed || []).forEach(function (f) {
      if (!f || out.length >= (max || ALERT_MAX)) return;
      var ts = Date.parse(f.ts);
      if (isFinite(ts) && now - ts > ALERT_WINDOW_MS) return;
      var k = f.kind, text = plain(f.html), tone = null;
      if (k === "approval") { tone = "warn"; text = text.replace(/^Approval needed · /, "Needs you: "); }
      else if (k === "error") tone = "err";
      else if (k === "warn") tone = "warn";
      else if (k === "idle") { tone = "ok"; var n = boldOf(f.html), q = /<span class="q">([\s\S]*?)<\/span>/.exec(str(f.html)); text = (n || "A session") + " is done" + (q && plain(q[1]) ? ": " + plain(q[1]) : ""); }
      else if (k === "session") { if (!/ ended$/.test(text)) return; tone = "info"; }
      else if (k === "approved") tone = "ok";
      // Proactive JOYA AI (public/joya-proactive.js): a watcher that fired, a brief or catch-up written.
      else if (k === "watch") { tone = "warn"; text = text.replace(/^Watcher · /, ""); }
      else if (k === "brief") tone = "info";
      else if (k === "denied" || k === "expired" || k === "withdrawn") tone = "info";
      if (!tone) return;
      out.push({ key: str(f.key), tone: tone, text: clip(text, 110), ago: isFinite(ts) ? ago(now - ts) : "", ts: isFinite(ts) ? ts : 0 });
    });
    return out;
  }

  return { approvals: approvals, sessions: sessions, cost: cost, alerts: alerts, tok: tok, ago: ago, mmss: mmss, plain: plain, sessKey: sessKey, isAiName: isAiName, MAX_APPROVALS: MAX_APPROVALS, ALERT_MAX: ALERT_MAX };
});
