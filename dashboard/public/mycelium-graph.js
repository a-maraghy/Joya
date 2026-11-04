"use strict";
/*
 * The Machine core's dependency logic, shared by the page (mycelium.js) and
 * the tests (tools/test-mycelium.cjs). No DOM, no drawing.
 *
 * Nodes are the tracked units (id = unit name) and the channels that run
 * inside an agent (id = "ch:<slug>"). An edge {from, to, kind} reads "from
 * needs to", and its kind decides what a failure of `to` does to `from`:
 *   hard  - from stops too                 ("required")
 *   reach - from runs but cannot be reached ("reached through")
 *   soft  - part of from stops working      ("uses")
 *   guard - from keeps running, unprotected ("protected by")
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MycGraph = api;
})(typeof self !== "undefined" ? self : this, function () {
  var RANK = { failed: 6, inactive: 5, down: 4, unreach: 3, degraded: 2, unguarded: 1 };
  var KIND_WORD = { hard: "required", reach: "the way in", soft: "uses", guard: "protection" };
  var BY_WORD = { hard: "requires it", reach: "reached through it", soft: "uses it", guard: "protected by it" };
  var SHORT = { down: "stops", unreach: "unreachable", degraded: "partly down", unguarded: "unprotected" };

  /** A node's own state from systemd's ActiveState: ok, failed or inactive. */
  function baseState(active) {
    if (active == null || active === "active") return "ok";
    return active === "failed" ? "failed" : "inactive";
  }

  /**
   * Propagate failures along the edges until nothing changes.
   * nodes: [{id, state: ok|failed|inactive}]; returns {id: {k, via: [edge]}}
   * for every node that is failed, inactive or affected.
   */
  function effects(nodes, edges) {
    var eff = {};
    nodes.forEach(function (n) {
      if (n.state === "failed") eff[n.id] = { k: "failed", via: [] };
      else if (n.state === "inactive") eff[n.id] = { k: "inactive", via: [] };
    });
    var changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      edges.forEach(function (e) {
        var t = eff[e.to];
        if (!t) return;
        var dead = t.k === "failed" || t.k === "inactive" || t.k === "down";
        var nk = null;
        if (e.kind === "hard" && dead) nk = "down";
        else if (e.kind === "reach" && (dead || t.k === "unreach")) nk = "unreach";
        else if (e.kind === "soft" && dead) nk = "degraded";
        else if (e.kind === "guard" && dead) nk = "unguarded";
        if (!nk) return;
        var cur = eff[e.from];
        if (!cur || RANK[nk] > RANK[cur.k]) { eff[e.from] = { k: nk, via: [e] }; changed = true; }
        else if (cur.k === nk && cur.via.indexOf(e) < 0) cur.via.push(e);
      });
    }
    return eff;
  }

  function isDead(eff, id) { var e = eff[id]; return !!e && (e.k === "failed" || e.k === "inactive" || e.k === "down"); }
  function isOwnFault(eff, id) { var e = eff[id]; return !!e && (e.k === "failed" || e.k === "inactive"); }
  function isCut(eff, id) { var e = eff[id]; return !!e && RANK[e.k] >= RANK.unreach; }

  /** One sentence on what a node's state means, for the tooltip. */
  function effText(eff, id, nameOf) {
    var e = eff[id];
    if (!e) return "";
    var names = e.via.map(function (v) { return nameOf(v.to); }).join(", ");
    return {
      failed: "Failed.",
      inactive: "Not running.",
      down: "Will stop: it requires " + names + ".",
      unreach: "Still running, but unreachable: it is reached through " + names + ".",
      degraded: "Partly down: it uses " + names + ".",
      unguarded: "Still running, unprotected: " + names + " is down.",
    }[e.k];
  }

  /** What else goes down if `id` breaks, worst first: [{id, k, word}]. */
  function knockOn(nodes, edges, id) {
    var alone = nodes.map(function (n) { return { id: n.id, state: n.id === id ? "failed" : "ok" }; });
    var eff = effects(alone, edges);
    return nodes
      .filter(function (n) { return n.id !== id && eff[n.id]; })
      .sort(function (a, b) { return RANK[eff[b.id].k] - RANK[eff[a.id].k]; })
      .map(function (n) { return { id: n.id, k: eff[n.id].k, word: SHORT[eff[n.id].k] }; });
  }

  /** The subtitle's verdict: which units failed and what that affects. */
  function verdict(nodes, eff) {
    var units = nodes.filter(function (n) { return !n.channel; });
    var bad = units.filter(function (n) { return isOwnFault(eff, n.id); });
    var aff = nodes.filter(function (n) { return eff[n.id] && !isOwnFault(eff, n.id); });
    return { up: units.length - bad.length, total: units.length, bad: bad, affected: aff };
  }

  /**
   * The route an event takes across the web, as node ids, or null when the
   * nodes it needs are not on this map. Routes follow the edges only.
   */
  function route(ev, ids, channelOf) {
    var has = function (id) { return ids.indexOf(id) >= 0; };
    var r = null;
    switch (ev.type) {
      case "ssh-login": r = ["ufw", "ssh"]; break;
      case "ssh-fail": r = ["ufw", "ssh", "fail2ban"]; break;
      case "ban": case "unban": r = ["fail2ban", "ufw"]; break;
      case "panel-login": r = ["ufw", "nginx", "joya-dashboard"]; break;
      case "panel-fail": r = ["ufw", "nginx", "joya-dashboard", "fail2ban"]; break;
      case "audit": case "panel-action": r = ["joya-dashboard"]; break;
      case "turn": r = ev.source === "dashboard" ? ["joya-dashboard", "joya-ai"] : ["joya-ai"]; break;
      case "delegation": r = ["joya-ai"]; break;
      case "ingest": r = ["claude-memory", "postgresql@16-main"]; break;
      case "start": r = ev.unit ? [ev.unit] : null; break;
      case "reply": {
        var a = "joya-agent@" + ev.agent, ch = channelOf ? channelOf(a) : null;
        r = ch ? [ch, a, ch] : [a];
        break;
      }
      case "web_panel": r = ["ufw", "nginx", "joya-dashboard"]; break;
      case "web_odoo": r = ["ufw", "nginx", "odoo", "postgresql@16-main"]; break;
      case "web_other": r = ["ufw", "nginx"]; break;
      default: r = null;
    }
    if (!r || !r.every(has)) return null;
    return r;
  }

  function edgeKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  /**
   * Thread thickness from real 24 h traffic: every event type's 24 h count is
   * added to each thread its route crosses, then w = base + k * log10(1 + n).
   */
  function threadTraffic(totals, ids, channelOf) {
    var t = {};
    var add = function (type, n, extra) {
      if (!n) return;
      var r = route(Object.assign({ type: type }, extra || {}), ids, channelOf);
      if (!r) return;
      for (var i = 0; i < r.length - 1; i++) { var k = edgeKey(r[i], r[i + 1]); t[k] = (t[k] || 0) + n; }
    };
    Object.keys(totals || {}).forEach(function (type) {
      if (type === "turn_dashboard") add("turn", totals[type], { source: "dashboard" });
      else if (type === "reply_by_agent") Object.keys(totals[type] || {}).forEach(function (a) { add("reply", totals[type][a], { agent: a }); });
      else if (typeof totals[type] === "number") add(type, totals[type]);
    });
    return t;
  }
  function thickness(n) { return 0.9 + 0.75 * Math.log10(1 + (n || 0)); }

  return {
    RANK: RANK, KIND_WORD: KIND_WORD, BY_WORD: BY_WORD,
    baseState: baseState, effects: effects, isDead: isDead, isOwnFault: isOwnFault, isCut: isCut,
    effText: effText, knockOn: knockOn, verdict: verdict, route: route, edgeKey: edgeKey,
    threadTraffic: threadTraffic, thickness: thickness,
  };
});
