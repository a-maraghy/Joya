/*
 * The living canvas's layout policy (2026-10-20): what the Command Center's board shows, how big, and
 * where -- from the moment. Pure: the page (joya-canvas.js) gathers the facts, this decides, the
 * tests (tools/test-canvas-policy.cjs) check it. No DOM, no clock of its own (now and hour are given).
 *
 *   JoyaCanvasPolicy.plan(input) -> { mode, hero, tiles, attention, why }
 *   JoyaCanvasPolicy.learn(rows, opts) -> { standing: [key], suppressed: [key], rows }
 *   JoyaCanvasPolicy.incidents(input) -> the sessions that failed or wait long, most urgent first
 *
 * Modes, most urgent first:
 *   incident  a session failed (a delegation failed or was held, in the last FAIL_WINDOW) or has waited
 *             on the person WAIT_LONG or more: that session's card is the hero (centre, large, its error
 *             and "Fix it"); everything else steps down to small.
 *   brief     the morning brief is fresh (written in the last BRIEF_FRESH, in the morning of the person's
 *             day) or a catch-up is (CATCHUP_FRESH): the brief takes the centre.
 *   board     nothing urgent, and there are widgets (pinned, or an answer just given): they keep their size.
 *   calm      nothing at all: the core and a few quiet tiles.
 * The bot core stays the hero in every mode: the centre slot sits under it, the side columns beside it.
 *
 * Locked (the person's switch): the arrangement stays as it is -- no hero grows, sizes are the person's;
 * what would have changed it is listed in `attention` (the page shows it as a small badge).
 *
 * input: {
 *   now, hour (0-23, the person's zone), small (a phone),
 *   brief: { id, kind: "brief"|"catchup", at } | null,
 *   sessions: [{ key, name, state: working|waiting|idle, since, waiting_for }],
 *   failures: [{ key, name, at, status: failed|held, text, id }],   (delegations, newest first)
 *   acked: { "<incident id>": true },                                (incidents the person put away)
 *   pinned: [{ id, key, size }], offered: [{ id, key }],              (key = JoyaWidgets.learnKey)
 *   standing: [key],  (learned)   quiet: [key] (the default quiet tiles)
 *   locked: false | true
 * }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JoyaCanvasPolicy = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var P = {
    WAIT_LONG_MS: 10 * 60e3,
    FAIL_WINDOW_MS: 2 * 3600e3,
    BRIEF_FRESH_MS: 3 * 3600e3,
    CATCHUP_FRESH_MS: 30 * 60e3,
    MORNING_FROM: 5,
    MORNING_TO: 12,
    MAX_PER_COLUMN: 4,
    MAX_OFFERED: 2,
    MAX_QUIET: 3,
    // learning
    STANDING_PINS: 3,       // pinned at least this often...
    STANDING_RATIO: 2,      // ...and at least twice as often as dismissed
    SUPPRESS_DISMISSALS: 3, // dismissed this often, never pinned or opened: not offered again
  };
  var SIZES = { s: 1, m: 2, l: 3 };

  function num(v) { var n = typeof v === "number" ? v : Date.parse(v); return isFinite(n) ? n : NaN; }

  /** The sessions that need the person, most urgent first: failures (newest first), then the longest waits. */
  function incidents(inp) {
    var now = inp.now, acked = inp.acked || {}, out = [], seen = {};
    (inp.failures || []).forEach(function (f) {
      if (!f || (f.status !== "failed" && f.status !== "held")) return;
      var at = num(f.at);
      if (!(now - at <= P.FAIL_WINDOW_MS && now - at >= -60e3)) return;
      var id = "f:" + (f.id != null ? f.id : f.key + "@" + at);
      var k = String(f.key || f.name || "");
      if (acked[id] || seen[k]) return;
      seen[k] = 1;
      out.push({ id: id, reason: f.status, key: f.key || null, name: f.name || "A session", text: f.text || "", at: at, rank: 0 });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    var waits = [];
    (inp.sessions || []).forEach(function (s) {
      if (!s || s.state !== "waiting") return;
      var since = num(s.since);
      if (!isFinite(since) || now - since < P.WAIT_LONG_MS) return;
      var id = "w:" + s.key + "@" + since;
      if (acked[id] || seen[String(s.key)]) return;
      seen[String(s.key)] = 1;
      waits.push({ id: id, reason: "waiting", key: s.key, name: s.name || "A session", text: s.waiting_for ? "waiting for " + s.waiting_for : "waiting on you", at: since, waited: now - since, rank: 1 });
    });
    waits.sort(function (a, b) { return b.waited - a.waited; });
    return out.concat(waits);
  }

  function briefFresh(inp) {
    var b = inp.brief;
    if (!b) return false;
    var age = inp.now - num(b.at);
    if (!(age >= -60e3)) return false;
    if (b.kind === "catchup") return age <= P.CATCHUP_FRESH_MS;
    return age <= P.BRIEF_FRESH_MS && inp.hour >= P.MORNING_FROM && inp.hour < P.MORNING_TO;
  }

  function shrink(size, to) { return SIZES[size] > SIZES[to] ? to : size; }

  function plan(inp) {
    inp = inp || {};
    var inc = incidents(inp);
    var brief = briefFresh(inp);
    var pinned = (inp.pinned || []).slice();
    var offered = (inp.offered || []).slice(0, P.MAX_OFFERED);
    var mode = inc.length ? "incident" : brief ? "brief" : pinned.length || offered.length ? "board" : "calm";
    var why = mode === "incident" ? inc[0].name + (inc[0].reason === "waiting" ? " has waited on you " + Math.round(inc[0].waited / 60e3) + " min" : inc[0].reason === "held" ? "'s work is held" : "'s work failed")
      : mode === "brief" ? (inp.brief.kind === "catchup" ? "while you were away" : "the morning brief is fresh")
      : mode === "board" ? "your widgets" : "all calm";
    var locked = !!inp.locked;
    var attention = [];
    var hero = null;
    if (locked) {
      // Nothing grows; what would have is listed, small.
      attention = inc.map(function (i) { return { id: i.id, key: i.key, name: i.name, reason: i.reason }; });
      if (brief) attention.push({ id: "brief", reason: "brief" });
      mode = pinned.length || offered.length ? "board" : "calm";
      why = "locked";
    } else if (mode === "incident") {
      hero = { type: "session", id: inc[0].id, key: inc[0].key, name: inc[0].name, reason: inc[0].reason, text: inc[0].text, at: inc[0].at };
    } else if (mode === "brief") {
      hero = { type: "brief", id: inp.brief.id, kind: inp.brief.kind };
    }

    var tiles = [];
    var hasKey = {};
    // An answer just given: beside the reply (the centre, under the core) unless something holds the centre.
    offered.forEach(function (w) {
      hasKey[w.key] = 1;
      tiles.push({ id: w.id, type: "offered", key: w.key, size: inp.small ? "m" : "m", slot: hero ? "right" : "centre", quiet: false });
    });
    // Other incidents than the hero: small session cards on the right.
    inc.slice(hero ? 1 : 0, 3).forEach(function (i) {
      if (locked) return;
      tiles.push({ id: "inc:" + i.id, type: "incident", key: i.key, name: i.name, reason: i.reason, size: "s", slot: "right", quiet: false });
    });
    // Pinned: their own size; stepped down while something else is the hero (never while locked).
    var leftN = 0, rightN = tiles.filter(function (t) { return t.slot === "right"; }).length;
    pinned.forEach(function (w) {
      hasKey[w.key] = 1;
      var size = SIZES[w.size] ? w.size : "m";
      if (!locked && hero) size = "s";
      var slot = inp.small ? "tray" : leftN < P.MAX_PER_COLUMN ? "left" : "right";
      if (slot === "left") leftN++;
      else if (slot === "right") { rightN++; if (rightN > P.MAX_PER_COLUMN) size = "s"; }
      tiles.push({ id: w.id, type: "pinned", key: w.key, size: size, slot: slot, quiet: false });
    });
    // Standing tiles: what the person keeps pinning (learned), else the default quiet ones -- small and dim.
    var stand = [];
    (inp.standing || []).forEach(function (k) { if (!hasKey[k] && stand.indexOf(k) < 0) stand.push(k); });
    if (!stand.length || mode === "calm") (inp.quiet || []).forEach(function (k) { if (!hasKey[k] && stand.indexOf(k) < 0) stand.push(k); });
    stand.slice(0, P.MAX_QUIET).forEach(function (k) {
      var slot = inp.small ? "tray" : "right";
      tiles.push({ id: "std:" + k, type: "standing", key: k, size: "s", slot: slot, quiet: true });
    });
    // A phone: two quiet tiles at most, under the core.
    if (inp.small) {
      var q = 0;
      tiles = tiles.filter(function (t) { return t.type !== "standing" || ++q <= 2; });
    }
    return { mode: mode, hero: hero, tiles: tiles, attention: attention, locked: locked, why: why };
  }

  /**
   * What the board learned about one person, from their counts per widget key
   * (rows: [{ key, offered, pins, dismissals, opens }]):
   *   standing   pinned often (>= STANDING_PINS, and >= STANDING_RATIO x dismissed): becomes a standing tile;
   *   suppressed always dismissed (>= SUPPRESS_DISMISSALS, never pinned or opened): no longer offered.
   */
  function learn(rows, opts) {
    var o = opts || {};
    var pins = o.pins || P.STANDING_PINS, ratio = o.ratio || P.STANDING_RATIO, dis = o.dismissals || P.SUPPRESS_DISMISSALS;
    var standing = [], suppressed = [], out = [];
    (rows || []).forEach(function (r) {
      if (!r || !r.key) return;
      var p = r.pins | 0, d = r.dismissals | 0, op = r.opens | 0;
      var st = p >= pins && p >= ratio * d;
      var sp = !st && d >= dis && p === 0 && op === 0;
      if (st) standing.push(r.key);
      if (sp) suppressed.push(r.key);
      out.push({ key: r.key, offered: r.offered | 0, pins: p, dismissals: d, opens: op, verdict: st ? "standing" : sp ? "not offered" : "" });
    });
    return { standing: standing, suppressed: suppressed, rows: out };
  }

  return { plan: plan, learn: learn, incidents: incidents, briefFresh: briefFresh, POLICY: P, SIZES: SIZES };
});
