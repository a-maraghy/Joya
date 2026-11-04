"use strict";
/*
 * Machine core: the host as a mycelium (the OS overview, route /).
 *
 * Every tracked unit is a knot on the web and every thread a real dependency
 * (lib/pulse.js EDGE_RULES), as thick as the log of the real traffic that
 * crossed it in the last 24 hours. Real events arrive from /api/os/pulse every
 * few seconds and run along the threads they really take. A unit that is not
 * active withers, its threads go dark, pulses fizzle where they meet it, and
 * the subtitle names it and what it takes down with it.
 *
 * One canvas: a static layer rendered offscreen when the size, theme or state
 * changes, and a thin animated layer over it per frame. requestAnimationFrame,
 * devicePixelRatio-aware, paused when the tab is hidden or the panel is off
 * screen, one still frame under prefers-reduced-motion. No demo controls.
 */
(function () {
  var hero = document.getElementById("mc-hero");
  var G = window.MycGraph;
  if (!hero || !G) return;
  var D;
  try { D = JSON.parse(hero.getAttribute("data-myc") || "{}"); } catch (e) { return; }
  var cv = hero.querySelector("canvas");
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext("2d");
  var layer = document.createElement("canvas"), lctx = layer.getContext("2d");
  var root = document.documentElement;
  var TAU = Math.PI * 2;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var POLL_MS = 4000;

  var NODES = (D.nodes || []).slice(), EDGES = D.edges || [], BY = {};
  NODES.forEach(function (n) { BY[n.id] = n; });
  var IDS = NODES.map(function (n) { return n.id; });
  var totals = D.totals || null;
  var eff = {};
  function nameOf(id) { return BY[id] ? BY[id].name : id; }
  function channelOf(agentId) {
    for (var i = 0; i < EDGES.length; i++) if (EDGES[i].to === agentId && BY[EDGES[i].from] && BY[EDGES[i].from].channel) return EDGES[i].from;
    return null;
  }
  function recompute() { eff = G.effects(NODES, EDGES); }
  function isDead(id) { return G.isDead(eff, id); }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* ------------------------------------------------------------ palette -- */
  var pal = {};
  var probe = document.createElement("canvas").getContext("2d");
  function rgb(str) {
    probe.fillStyle = "#000"; probe.fillStyle = str || "#000";
    var s = probe.fillStyle;
    if (s[0] === "#") return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
    var m = s.match(/[\d.]+/g) || [0, 0, 0, 1];
    return [+m[0], +m[1], +m[2], m[3] == null ? 1 : +m[3]];
  }
  function css(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + (a == null ? c[3] : a) + ")"; }
  var TOKENS = ["--ink", "--muted", "--accent", "--accent-2", "--warn", "--bad", "--orb-node-bg", "--orb-root-hi",
    "--dry", "--dry-crack", "--sub-a", "--hypha", "--hypha-faint", "--pulse", "--pulse-glow", "--spore", "--dark-thread", "--teal-line", "--grid-dot"];
  function readPalette() {
    var cs = getComputedStyle(root);
    pal = { rgb: {} };
    TOKENS.forEach(function (t) { pal[t] = cs.getPropertyValue(t).trim(); pal.rgb[t] = rgb(pal[t]); });
  }
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  var rnd = rng(42);

  /* ------------------------------------------------------------- layout -- */
  // Positions as fractions of the panel. The first agent and its channel take
  // the places the approved design gave them; more agents fan out from there.
  var SLOTS = {
    "fail2ban": [.05, .40, "r"], "ufw": [.09, .70, "r"], "nginx": [.31, .50, "r"], "ssh": [.28, .88, "r"],
    "joya-dashboard": [.50, .32, "r"], "odoo": [.53, .64, "r"], "joya-ai": [.43, .08, "r"], "claude-memory": [.74, .42, "r"],
    "postgresql@16-main": [.78, .72, "r"], "xrdp": [.47, .84, "r"], "xrdp-sesman": [.66, .97, "r"],
  };
  var AGENT_SLOTS = [[.22, .20], [.33, .27], [.62, .16], [.88, .20], [.90, .32], [.62, .05]];
  var L = {};
  (function place() {
    var agents = NODES.filter(function (n) { return n.kind === "agent"; });
    agents.forEach(function (n, i) {
      var s = AGENT_SLOTS[Math.min(i, AGENT_SLOTS.length - 1)];
      L[n.id] = { fx: s[0], fy: i < AGENT_SLOTS.length ? s[1] : Math.min(.98, s[1] + (i - AGENT_SLOTS.length + 1) * .07), side: s[0] > .8 ? "l" : "r" };
      var ch = channelOf(n.id);
      if (ch) L[ch] = i === 0 ? { fx: .04, fy: .06, side: "r" } : { fx: Math.max(.02, L[n.id].fx - .07), fy: Math.max(0, L[n.id].fy - .1), side: L[n.id].side };
    });
    var other = 0, wa = 0;
    NODES.forEach(function (n) {
      if (L[n.id]) return;
      if (SLOTS[n.id]) { L[n.id] = { fx: SLOTS[n.id][0], fy: SLOTS[n.id][1], side: SLOTS[n.id][2] }; return; }
      if (n.kind === "whatsapp") { L[n.id] = { fx: .97, fy: Math.min(.98, .57 + .12 * wa++), side: "l" }; return; }
      L[n.id] = { fx: .97, fy: Math.min(.98, .08 + .1 * other++), side: "l" };
    });
  })();

  var W = 0, H = 0, dpr = 1, compact = false, pos = {}, threads = {}, pulses = [], ripples = [], spores = [], dirty = true;
  var traffic = {};
  function key(a, b) { return G.edgeKey(a, b); }
  function inbound() {
    if (!totals) return 1;
    return (totals["ssh-login"] || 0) + (totals["ssh-fail"] || 0) + (totals.web_panel || 0) + (totals.web_odoo || 0) + (totals.web_other || 0) +
      (totals["panel-login"] || 0) + (totals["panel-fail"] || 0);
  }
  function layout() {
    var r = hero.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(2, window.devicePixelRatio || 1); compact = W < 820;
    [cv, layer].forEach(function (c) { c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(H * dpr)); });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var top = 64, bottom = H - 52, left = 26, right = W - 26;
    pos = {};
    Object.keys(L).forEach(function (id) { var l = L[id]; pos[id] = { x: left + l.fx * (right - left), y: top + l.fy * (bottom - top), side: l.side }; });
    traffic = G.threadTraffic(totals || {}, IDS, channelOf);
    threads = {};
    var rr = rng(19);
    EDGES.forEach(function (e) {
      var k = key(e.from, e.to);
      if (threads[k]) { threads[k].kinds.push(e.kind); return; }
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      threads[k] = { a: e.from, b: e.to, kinds: [e.kind], main: hypha(a, b, rr, 1), twin: hypha(a, b, rr, .6), w: G.thickness(traffic[k] || 1) };
    });
    // the edge of the world: inbound through the firewall, and each channel out to its service
    if (pos.ufw) threads["ufw|out"] = { a: "ufw", b: null, kinds: ["edge"], main: hypha(pos.ufw, { x: -10, y: pos.ufw.y + 14 }, rr, .8), twin: null, w: G.thickness(inbound()) };
    NODES.forEach(function (n) {
      if (!n.channel || !pos[n.id]) return;
      var agent = n.id && EDGES.filter(function (e) { return e.from === n.id; })[0];
      var agentSlug = agent ? agent.to.replace(/^joya-agent@/, "") : "";
      var nrep = totals && totals.reply_by_agent ? totals.reply_by_agent[agentSlug] || 1 : 1;
      threads[n.id + "|out"] = { a: n.id, b: null, kinds: ["edge"], main: hypha(pos[n.id], { x: -10, y: pos[n.id].y + 22 }, rr, .8), twin: null, w: G.thickness(nrep) };
    });
    dirty = true;
  }
  // A thread: a cubic with horizontal tangents at both knots -- the flat,
  // structural look of the Joya, drawn as a polyline so the pulses can
  // travel along it. `amp` spreads twin threads apart; `r` is kept for the
  // call sites (and the deterministic layout they share).
  function hypha(a, b, r, amp) {
    r();
    var n = 32, pts = [], mx = (a.x + b.x) / 2, off = (1 - amp) * 10;
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var x = u * u * u * a.x + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * b.x;
      var y = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y + Math.sin(Math.PI * t) * off;
      pts.push([x, y]);
    }
    var cum = [0]; for (i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { pts: pts, len: cum, total: cum[cum.length - 1] };
  }

  /* ------------------------------------------------------------- labels -- */
  var lblBox = hero.querySelector("[data-mc-labels]");
  var labels = {};
  NODES.forEach(function (n) {
    var a = document.createElement("span");
    a.className = "mc-lbl"; a.setAttribute("data-id", n.id); a.setAttribute("tabindex", "0");
    var dot = document.createElement("span"); dot.className = "dot";
    var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = n.name;
    var sm = document.createElement("small"); sm.textContent = n.channel ? "telegram" : n.id;
    var ai = document.createElement("span"); ai.className = "aff-i"; ai.setAttribute("aria-hidden", "true"); ai.textContent = "!";
    a.appendChild(dot); a.appendChild(nm); a.appendChild(sm); a.appendChild(ai);
    lblBox.appendChild(a); labels[n.id] = a;
  });
  function syncLabels() {
    NODES.forEach(function (n) {
      var el = labels[n.id], e = eff[n.id];
      el.classList.toggle("bad", !!e && e.k === "failed");
      el.classList.toggle("warn", !!e && e.k === "inactive");
      el.classList.toggle("aff", !!e && e.k !== "failed" && e.k !== "inactive");
      el.setAttribute("aria-label", n.name + ": " + (e ? G.effText(eff, n.id, nameOf) : "active"));
    });
  }
  function placeLabels() {
    NODES.forEach(function (n) {
      var el = labels[n.id], p = pos[n.id];
      if (!p) { el.style.display = "none"; return; }
      el.style.display = "";
      var w = el.offsetWidth, h = el.offsetHeight, gap = 11;
      var x = p.side === "l" ? p.x - gap - w : p.x + gap;
      if (p.side === "r" && x + w > W - 6) x = p.x - gap - w;
      if (p.side === "l" && x < 6) x = p.x + gap;
      var y = p.y - h / 2;
      x = Math.max(6, Math.min(W - w - 6, x)); y = Math.max(4, Math.min(H - h - 4, y));
      el.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
      el._box = [x, y, w, h];
    });
  }

  /* ------------------------------------------------------------ verdict -- */
  var pill = hero.querySelector("[data-mc-pill]");
  var sub = hero.querySelector("[data-mc-sub]");
  var count = hero.querySelector("[data-mc-count]");
  function syncVerdict() {
    var v = G.verdict(NODES, eff);
    pill.textContent = v.up + " of " + v.total + " services up";
    pill.className = "pill hero-pill " + (v.bad.length ? "bad" : v.affected.length ? "warn" : "ok");
    if (count) count.textContent = v.up + " / " + v.total;
    if (!v.bad.length && !v.affected.length) {
      sub.innerHTML = compact ? "<b>All up</b> · nothing affected" : "<b>All up</b> · nothing affected · threads = what needs what";
      return;
    }
    sub.innerHTML = v.bad.map(function (n) {
      return '<span class="v-bad">' + esc(n.name) + (eff[n.id].k === "failed" ? " failed" : " stopped") + "</span>";
    }).join(", ") + (v.affected.length ? ' · <span class="v-warn">' + v.affected.length + " affected</span>" +
      (compact ? "" : ": " + v.affected.map(function (n) { return esc(n.name) + " (" + { down: "stopped", unreach: "unreachable", degraded: "partly down", unguarded: "unprotected" }[eff[n.id].k] + ")"; }).join(", ")) : "");
  }

  /* ------------------------------------------------------------ tooltip -- */
  var tip = hero.querySelector("[data-mc-tip]");
  var hover = null, pinned = null, hiId = null;
  function tipHtml(id) {
    var n = BY[id], e = eff[id];
    var st;
    if (!e) st = '<span class="st-ok">' + (n.channel ? "running" : "active") + "</span>" + (n.channel ? ' <span class="u">in the agent process</span>' : "");
    else if (e.k === "failed") st = '<span class="st-bad">failed</span>';
    else if (e.k === "inactive") st = '<span class="st-warn">' + esc(n.active || "inactive") + "</span>";
    else st = '<span class="st-ok">' + (n.channel ? "running" : "active") + '</span> · <span class="st-warn">affected</span>';
    var needs = EDGES.filter(function (x) { return x.from === id; });
    var by = EDGES.filter(function (x) { return x.to === id; });
    var needList = needs.length ? needs.map(function (x) { return esc(nameOf(x.to)) + ' <span class="u">· ' + G.KIND_WORD[x.kind] + "</span>"; }).join("<br>") : '<span class="u">nothing on this box</span>';
    var byList = by.length ? by.map(function (x) { return esc(nameOf(x.from)) + ' <span class="u">· ' + G.BY_WORD[x.kind] + "</span>"; }).join("<br>") : '<span class="u">nothing</span>';
    var down = G.knockOn(NODES, EDGES, id).map(function (m) { return nameOf(m.id) + " (" + m.word + ")"; });
    return "<h4>" + '<span class="dot' + (e ? (e.k === "failed" ? " bad" : " warn") : "") + '"></span>' + esc(n.name) + "</h4>" +
      '<div class="u">' + esc(n.unit) + "</div>" +
      "<dl><dt>State</dt><dd>" + st + "</dd>" +
      (n.since || n.mem ? "<dt>Since</dt><dd>" + esc(n.since || "—") + (n.mem ? ' <span class="u">· ' + esc(n.mem) + "</span>" : "") + "</dd>" : "") +
      "<dt>Needs</dt><dd>" + needList + "</dd>" +
      "<dt>Needed by</dt><dd>" + byList + "</dd>" +
      (e && e.k !== "failed" && e.k !== "inactive" ? "<dt>Effect</dt><dd>" + esc(G.effText(eff, id, nameOf)) + "</dd>" : "") +
      "<dt>" + (e && (e.k === "failed" || e.k === "inactive") ? "Knocked on" : "If it breaks") + "</dt><dd>" +
      (down.length ? esc(down.join(", ")) : '<span class="u">nothing else goes down</span>') + "</dd>" +
      "</dl>" + (n.role ? "<p>" + esc(n.role) + "</p>" : "");
  }
  function showTip(id) {
    if (!id || !BY[id] || !pos[id]) { tip.hidden = true; setHi(null); return; }
    tip.innerHTML = tipHtml(id); tip.hidden = false;
    var p = pos[id], tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = p.x > W * .55 ? p.x - 18 - tw : p.x + 18, y = p.y - th / 2;
    if (x + tw > W - 8) x = p.x - 18 - tw;
    if (x < 8) x = Math.max(8, Math.min(W - tw - 8, p.x - tw / 2));
    y = Math.max(8, Math.min(H - th - 8, y));
    tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
    setHi(id);
  }
  function setHi(id) {
    hiId = id;
    var rel = {};
    if (id) { rel[id] = 1; EDGES.forEach(function (e) { if (e.from === id) rel[e.to] = 1; if (e.to === id) rel[e.from] = 1; }); }
    NODES.forEach(function (n) {
      labels[n.id].classList.toggle("hi", n.id === id);
      labels[n.id].classList.toggle("dim", !!id && !rel[n.id]);
    });
    dirty = true; if (!running) paint();
  }
  lblBox.addEventListener("mouseover", function (ev) { var l = ev.target.closest(".mc-lbl"); if (l && !pinned) { hover = l.getAttribute("data-id"); showTip(hover); } });
  lblBox.addEventListener("mouseout", function (ev) { var l = ev.target.closest(".mc-lbl"); if (l && !pinned) { hover = null; showTip(null); } });
  lblBox.addEventListener("focusin", function (ev) { var l = ev.target.closest(".mc-lbl"); if (l) showTip(l.getAttribute("data-id")); });
  lblBox.addEventListener("focusout", function () { if (!pinned) showTip(null); });
  function nodeAt(x, y) {
    var best = null, bd = 16 * 16;
    Object.keys(pos).forEach(function (id) { var p = pos[id], d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y); if (d < bd) { bd = d; best = id; } });
    NODES.forEach(function (n) { var b = labels[n.id]._box; if (b && labels[n.id].style.display !== "none" && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) best = n.id; });
    return best;
  }
  hero.addEventListener("mousemove", function (ev) {
    if (pinned || ev.target.closest(".mc-lbl, .hero-stats, .hero-pill")) return;
    var r = hero.getBoundingClientRect(), id = nodeAt(ev.clientX - r.left, ev.clientY - r.top);
    if (id !== hover) { hover = id; showTip(id); }
    hero.style.cursor = id ? "pointer" : "";
  });
  hero.addEventListener("mouseleave", function () { if (!pinned) { hover = null; showTip(null); } });
  hero.addEventListener("click", function (ev) {
    if (ev.target.closest(".hero-stats a")) return;
    var r = hero.getBoundingClientRect(), id = nodeAt(ev.clientX - r.left, ev.clientY - r.top);
    pinned = id && pinned !== id ? id : null;
    showTip(pinned || id);
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && pinned) { pinned = null; showTip(null); } });

  /* ------------------------------------------------------------ drawing -- */
  function threadState(t) {
    var ea = eff[t.a], eb = t.b ? eff[t.b] : null;
    if (G.isOwnFault(eff, t.a) || (t.b && G.isOwnFault(eff, t.b)) || (ea && ea.k === "down") || (eb && eb.k === "down")) return "dark";
    if (G.isCut(eff, t.a) || (t.b && G.isCut(eff, t.b))) return "dim";
    return "ok";
  }
  function stroke(c, pts, w) { c.lineWidth = Math.max(.8, w * .75); c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.stroke(); }
  function drawLayer() {
    var c = lctx, P = pal;
    c.clearRect(0, 0, W, H);
    // substrate: a faint structural dot grid
    c.fillStyle = P["--grid-dot"] || "rgba(0,230,165,.06)";
    for (var gx = 12; gx < W; gx += 22) for (var gy = 10; gy < H; gy += 22) c.fillRect(gx, gy, 1.2, 1.2);
    Object.keys(threads).forEach(function (k) {
      var t = threads[k], st = threadState(t), rel = !hiId || t.a === hiId || t.b === hiId;
      var soft = t.kinds.every(function (x) { return x === "soft" || x === "guard"; });
      var col = st === "dim" ? css(pal.rgb["--warn"], .35) : soft ? css(pal.rgb["--hypha"], .38) : P["--hypha"];
      if (!rel) col = P["--hypha-faint"];
      c.strokeStyle = col; c.lineCap = "round"; c.lineJoin = "round";
      if (st === "dark") { c.strokeStyle = css(pal.rgb["--dry"], .9); c.setLineDash([2, 5]); stroke(c, t.main.pts, 1.3); c.setLineDash([]); return; }
      stroke(c, t.main.pts, t.w);
      // twins stay flat: the traffic is in the width, not in a second strand
    });
  }
  function at(h, d, rev) {
    if (rev) d = h.total - d;
    var L2 = h.len, i = 1; while (i < L2.length - 1 && L2[i] < d) i++;
    var a = h.pts[i - 1], b = h.pts[i], f = (d - L2[i - 1]) / Math.max(.001, L2[i] - L2[i - 1]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  function render(T) {
    if (!W || !H) return;
    if (dirty) { drawLayer(); dirty = false; }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(layer, 0, 0, W, H);
    var still = reduced.matches, i, k;
    for (i = 0; i < pulses.length; i++) {
      var p = pulses[i], h = p.hop, d = Math.min(p.d, h.th.total), pt = at(h.th, d, h.rev);
      var col = p.ban ? pal["--spore"] : pal["--pulse"], rad = p.faint ? 1.7 : 2.6;
      // flat square pulses, a short fading trail behind the live ones
      ctx.fillStyle = col;
      if (!p.faint) for (k = 1; k <= 3; k++) { if (d - k * 8 < 0) break; var tp = at(h.th, d - k * 8, h.rev); ctx.globalAlpha = .45 - k * .12; ctx.fillRect(tp[0] - rad * .8, tp[1] - rad * .8, rad * 1.6, rad * 1.6); }
      ctx.globalAlpha = p.faint ? .6 : 1;
      ctx.fillRect(pt[0] - rad, pt[1] - rad, rad * 2, rad * 2);
      ctx.globalAlpha = 1;
    }
    ripples.forEach(function (r) {
      var q = pos[r.id]; if (!q) return;
      var t = r.t / r.life;
      ctx.strokeStyle = r.col; ctx.globalAlpha = 1 - t; ctx.lineWidth = r.fizzle ? 1 : 1.6;
      ctx.beginPath(); ctx.arc(q.x, q.y, (r.fizzle ? 6 : 9) + t * (r.fizzle ? 8 : 22), 0, TAU); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    spores.forEach(function (s) {
      var t = s.t / s.life; ctx.fillStyle = pal["--spore"]; ctx.globalAlpha = 1 - t;
      ctx.beginPath(); ctx.arc(s.x + s.vx * s.t, s.y + s.vy * s.t, 3 * (1 - t * .4), 0, TAU); ctx.fill();
    });
    ctx.globalAlpha = 1;
    // the knots: fruiting bodies on the web; a dead one withers
    Object.keys(pos).forEach(function (id, j) {
      var q = pos[id], e = eff[id], dead = G.isOwnFault(eff, id) || (e && e.k === "down");
      var breath = still || dead ? 1 : 1 + .08 * Math.sin(T * 1.6 + j);
      if (dead) {
        ctx.fillStyle = pal["--dry"]; ctx.beginPath();
        for (var m = 0; m <= 9; m++) { var a = m / 9 * TAU, rr = (m % 2 ? 4 : 7); ctx.lineTo(q.x + Math.cos(a) * rr, q.y + Math.sin(a) * rr); }
        ctx.fill(); ctx.strokeStyle = G.isOwnFault(eff, id) ? pal["--bad"] : pal["--warn"]; ctx.lineWidth = 1.2; ctx.stroke();
        return;
      }
      // a flat ring on the surface colour, the joya dot inside; no glow
      ctx.fillStyle = pal["--orb-node-bg"]; ctx.strokeStyle = e ? pal["--warn"] : pal["--teal-line"]; ctx.lineWidth = 2;
      if (e) ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(q.x, q.y, 8 * (breath > 1.04 ? 1.04 : 1), 0, TAU); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = e ? pal["--warn"] : pal["--pulse"]; ctx.beginPath(); ctx.arc(q.x, q.y, 3.6, 0, TAU); ctx.fill();
      if (hiId === id) { ctx.strokeStyle = pal["--accent"]; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, TAU); ctx.stroke(); }
    });
  }

  /* ------------------------------------------------------------- pulses -- */
  function hopsFor(route) {
    var hops = [];
    for (var i = 0; i < route.length - 1; i++) {
      var th = threads[key(route[i], route[i + 1])];
      if (!th) return null;
      hops.push({ th: th.main, rev: th.a !== route[i], to: route[i + 1] });
    }
    return hops;
  }
  var FAINT = { "ssh-fail": 1, web_panel: 1, web_odoo: 1, web_other: 1 };
  /** Launch one event on the web. Returns false when its route starts at a dead knot. */
  function launch(ev) {
    var route = G.route(ev, IDS, channelOf);
    if (!route) return true; // not on this map: nothing to draw, still worth a ticker line
    if (isDead(route[0])) { ripples.push({ id: route[0], t: 0, life: .7, col: pal["--dry-crack"], fizzle: true }); return false; }
    var faint = !!FAINT[ev.type], ban = ev.type === "ban";
    if (ev.type === "start" || route.length === 1) { ripples.push({ id: route[0], t: 0, life: ev.type === "start" ? 1.4 : 1, col: pal["--accent"] }); return true; }
    var hops = hopsFor(route);
    if (!hops) return true;
    if (route[0] === "ufw" && threads["ufw|out"]) hops.unshift({ th: threads["ufw|out"].main, rev: true, to: "ufw" });
    if (ev.type === "reply" && threads[route[0] + "|out"]) hops.unshift({ th: threads[route[0] + "|out"].main, rev: true, to: route[0] });
    pulses.push({ hops: hops, i: 0, hop: hops[0], d: 0, v: faint ? 120 : 150, faint: faint, ban: ban });
    if (pulses.length > 160) pulses.splice(0, pulses.length - 160);
    return true;
  }
  function step(dt) {
    for (var i = pulses.length - 1; i >= 0; i--) {
      var p = pulses[i]; p.d += p.v * dt;
      if (p.d >= p.hop.th.total) {
        var to = p.hop.to;
        if (isDead(to)) { ripples.push({ id: to, t: 0, life: .7, col: pal["--dry-crack"], fizzle: true }); pulses.splice(i, 1); continue; }
        p.i++;
        if (p.i >= p.hops.length) {
          if (p.ban && pos.ufw) burst(pos.ufw);
          else if (!p.faint) ripples.push({ id: to, t: 0, life: .9, col: pal["--accent"] });
          pulses.splice(i, 1); continue;
        }
        p.hop = p.hops[p.i]; p.d = 0;
      }
    }
    ripples.forEach(function (r) { r.t += dt; }); ripples = ripples.filter(function (r) { return r.t < r.life; });
    spores.forEach(function (s) { s.t += dt; }); spores = spores.filter(function (s) { return s.t < s.life; });
  }
  function burst(p) { // a banned address: red spores thrown out past the edge
    ripples.push({ id: "ufw", t: 0, life: 1.2, col: pal["--spore"] });
    for (var i = 0; i < 24; i++) { var a = Math.PI * (.5 + rnd()); spores.push({ x: p.x - 4, y: p.y, vx: Math.cos(a) * (50 + rnd() * 90), vy: Math.sin(a) * (40 + rnd() * 70), t: 0, life: .9 + rnd() * .7 }); }
  }
  function stillPulses() {
    // reduced motion: one frame with a pulse resting on each busy live route
    pulses = [];
    ["web_panel", "ingest", "ssh-login", "web_odoo"].forEach(function (type, k) {
      var r = G.route({ type: type }, IDS, channelOf); if (!r || r.some(isDead)) return;
      var hops = hopsFor(r); if (!hops) return;
      pulses.push({ hops: hops, i: 0, hop: hops[0], d: hops[0].th.total * (.35 + (k % 3) * .15), v: 0, faint: k > 1 });
    });
  }

  /* ------------------------------------------------------------- ticker -- */
  var tick = hero.querySelector("[data-mc-ticker] ol"), tickItems = [];
  var tz = (document.querySelector("[data-clock]") || {}).getAttribute ? document.querySelector("[data-clock]").getAttribute("data-tz") : null;
  var fmt; try { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); } catch (e) { fmt = null; }
  function label(ev) {
    switch (ev.type) {
      case "ssh-login": return "SSH sign-in";
      case "ban": return "fail2ban ban · " + (ev.jail || "");
      case "unban": return "fail2ban unban · " + (ev.jail || "");
      case "panel-login": return "panel sign-in";
      case "panel-fail": return "failed panel sign-in";
      case "panel-action": return "panel · " + (ev.action || "");
      case "audit": return "audit · " + (ev.action || "");
      case "turn": return "JOYA AI turn";
      case "delegation": return "JOYA AI delegation";
      case "ingest": return "memory ingest";
      case "start": return "started · " + (ev.unit || "");
      case "reply": return "agent reply · " + (ev.agent || "");
      default: return null;
    }
  }
  function ticker(ev, blocked) {
    var text = label(ev);
    if (!text || FAINT[ev.type]) return;
    var d = new Date(ev.at);
    var t = isNaN(d) ? "" : fmt ? fmt.format(d) : d.toTimeString().slice(0, 8);
    tickItems.unshift({ t: t, text: text + (blocked ? " · stopped" : ""), ban: ev.type === "ban" || ev.type === "panel-fail" });
    tickItems = tickItems.slice(0, 4);
    tick.innerHTML = tickItems.map(function (i) { return '<li class="' + (i.ban ? "ban" : "") + '">' + esc(i.t) + " <b>" + esc(i.text) + "</b></li>"; }).join("");
  }
  function tickerEmpty() {
    if (!tickItems.length) tick.innerHTML = '<li class="quiet">listening…</li>';
  }

  /* --------------------------------------------------------------- feed -- */
  var seq = 0, gotFirst = false, queue = [], pollTimer = 0, stopped = false, lastTotals = Date.now();
  function fire(ev) { var ok = launch(ev); ticker(ev, !ok); }
  function schedule(events, first) {
    var notes = [], faint = [];
    events.forEach(function (ev) {
      if (ev.type === "web_panel" || ev.type === "web_odoo" || ev.type === "web_other") {
        for (var i = 0; i < Math.min(ev.n || 1, first ? 0 : 8); i++) faint.push({ type: ev.type, at: ev.at });
      } else if (FAINT[ev.type]) { if (!first) faint.push(ev); }
      else notes.push(ev);
    });
    if (first) {
      // what already happened: the last few straight into the ticker, the newest also on the web
      notes.slice(-4).forEach(function (ev) { ticker(ev, false); });
      notes.slice(-2).forEach(function (ev) { launch(ev); });
      tickerEmpty();
      return;
    }
    faint = faint.slice(-30);
    var now = performance.now();
    notes.forEach(function (ev, i) { queue.push({ due: now + (i + 1) * (POLL_MS / (notes.length + 1)), ev: ev, note: true }); });
    faint.forEach(function (ev) { queue.push({ due: now + rnd() * POLL_MS, ev: ev }); });
    if (reduced.matches || !running) drain(Infinity);
  }
  function drain(now) {
    if (!queue.length) return;
    var keep = [];
    queue.forEach(function (q) {
      if (q.due > now) { keep.push(q); return; }
      if (reduced.matches || !running) { if (q.note) ticker(q.ev, G.route(q.ev, IDS, channelOf) ? G.route(q.ev, IDS, channelOf).some(isDead) : false); }
      else fire(q.ev);
    });
    queue = keep;
    if (reduced.matches) { stillPulses(); paint(); }
  }
  function applyUnits(units) {
    if (!Array.isArray(units)) return;
    var changed = false;
    units.forEach(function (u) {
      var n = BY[u.unit]; if (!n) return;
      var st = G.baseState(u.active);
      if (n.state !== st || n.active !== u.active) { n.state = st; n.active = u.active; changed = true; }
      if (u.since) n.since = u.since;
      if (u.memory != null) n.mem = u.memory >= 1073741824 ? (u.memory / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round(u.memory / 1048576)) + " MB";
    });
    if (changed) { recompute(); syncLabels(); syncVerdict(); dirty = true; if (!running) { if (reduced.matches) stillPulses(); paint(); } }
  }
  function poll() {
    pollTimer = 0;
    if (stopped) return;
    if (document.hidden) { pollTimer = setTimeout(poll, POLL_MS); return; }
    var wantTotals = Date.now() - lastTotals > 10 * 60 * 1000;
    fetch("/api/os/pulse?since=" + seq + (wantTotals || !totals ? "&totals=1" : ""), { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { stopped = true; throw new Error("signed out"); }
        if (!r.ok) throw new Error("pulse " + r.status);
        return r.json();
      })
      .then(function (d) {
        var first = !gotFirst;
        gotFirst = true;
        if (d.totals) {
          lastTotals = Date.now();
          var had = JSON.stringify(totals);
          totals = d.totals;
          if (JSON.stringify(totals) !== had) { layout(); placeLabels(); if (!running) paint(); }
        }
        applyUnits(d.units);
        var evs = (d.events || []).filter(function (e) { return e.seq > seq; });
        if (typeof d.seq === "number") seq = Math.max(seq, d.seq);
        schedule(evs, first);
      })
      .catch(function () { /* keep the web as it is; try again */ })
      .then(function () { if (!stopped) pollTimer = setTimeout(poll, POLL_MS); });
  }

  /* --------------------------------------------------------- frame loop -- */
  var running = false, raf = 0, last = 0, T = 0, visible = true;
  function paint() { render(T); }
  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now; T += dt;
    drain(performance.now());
    step(dt);
    paint();
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (reduced.matches) { running = false; stillPulses(); paint(); return; }
    if (running || document.hidden || !visible) return;
    running = true; last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function relayout() {
    hero.classList.toggle("compact", hero.clientWidth < 820);
    layout(); placeLabels(); syncVerdict();
    if (!running) { if (reduced.matches) stillPulses(); paint(); }
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
  if (window.IntersectionObserver) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) start(); else stop(); }).observe(hero);
  if (window.ResizeObserver) new ResizeObserver(function () { relayout(); }).observe(hero);
  function retheme() { setTimeout(function () { readPalette(); dirty = true; if (!running) paint(); }, 0); }
  document.addEventListener("joya-theme", retheme);
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
  if (reduced.addEventListener) reduced.addEventListener("change", function () { stop(); start(); });

  readPalette(); recompute(); syncLabels();
  relayout();
  tickerEmpty();
  start();
  poll();
})();
