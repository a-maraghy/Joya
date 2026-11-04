"use strict";
/*
 * The memory graph: one component, used for Claude Code's long-term memory
 * (/claude/memory) and for the agents' vaults (/agents/:slug/memory).
 *
 * A canvas and a force layout of its own -- no library, because the CSP allows
 * no CDN and nothing this small needs one:
 *
 *   layout     many-body repulsion by Barnes-Hut on a quadtree (O(n log n)),
 *              springs along the links, a weak pull to the centre, and a
 *              cooling "alpha" so the graph settles and then stops costing
 *              anything. The loop sleeps when settled, when the tab is hidden,
 *              and when the panel is not on screen; any interaction wakes it.
 *   drawing    links batched into one path per kind, nodes batched per colour,
 *              hubs with a halo from a pre-rendered sprite. Labels by level of
 *              detail: hubs when zoomed out, everything when zoomed in, and
 *              always the hovered, selected and matched ones -- placed against
 *              a coarse grid so they never pile up. Right-to-left labels
 *              (Arabic, Hebrew, Persian) are drawn with the canvas's own bidi
 *              by setting its direction per label.
 *   growth     the page polls for what is new; new nodes are placed beside
 *              what they link to and grow in, forgotten ones fade out.
 *   search     typing highlights keyword matches and frames them; Enter asks
 *              the server's own search "by meaning" and highlights its hits.
 *   keyboard   "/" search, "+" / "-" zoom, "0" fit, Esc clears.
 *
 * Everything that reaches the DOM goes through textContent or createElement:
 * memory text is data, never markup. Colours are theme tokens (--g-*), read
 * from the stylesheet and re-read when the theme changes.
 */

(function () {
  var TAU = Math.PI * 2;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  var RTL_FIRST = /^[^A-Za-zÀ-ɏ֐-ࣿיִ-﷿ﹰ-﻿]*[֐-ࣿיִ-﷿ﹰ-﻿]/;

  /* Types, in the order the filter list shows them, with their colour token. */
  var TYPES = [
    ["project", "Projects", "--g-project"],
    ["agent", "Agents", "--g-project"],
    ["people", "People", "--g-people"],
    ["topic", "Topics", "--g-topic"],
    ["session", "Sessions", "--g-session"],
    ["conversation", "Conversations", "--g-conv"],
    ["call", "Calls", "--g-conv"],
    ["file", "Uploaded files", "--g-file"],
    ["document", "Documents", "--g-doc"],
    ["research", "Research", "--g-figure"],
    ["report", "Reports", "--g-doc"],
    ["output", "Outputs", "--g-run"],
    ["decision", "Decisions", "--g-decision"],
    ["figure", "Figures", "--g-figure"],
    ["trap", "Traps", "--g-trap"],
    ["open_issue", "Open issues", "--g-issue"],
    ["preference", "Preferences", "--g-pref"],
    ["goal", "Goals", "--g-decision"],
    ["pattern", "Work patterns", "--g-run"],
    ["run", "Runs", "--g-run"],
    ["fact", "Facts", "--g-fact"],
    ["note", "Notes", "--g-fact"],
  ];
  var TYPE = {};
  TYPES.forEach(function (t, i) { TYPE[t[0]] = { key: t[0], label: t[1], token: t[2], order: i }; });
  function typeOf(t) { return TYPE[t] || TYPE.note; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function dirOf(text) { return RTL_FIRST.test(String(text || "")) ? "rtl" : "ltr"; }
  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d)) return String(ts).slice(0, 16);
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
  function getJSON(url) {
    return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || "request failed (" + r.status + ")");
        return d;
      });
    });
  }

  /* ------------------------------------------------------ quadtree (BH) --- */
  // A plain quadtree over node positions. Each internal cell carries its total
  // charge and charge-weighted centre, so a far cluster acts as one body.
  function Quad(x0, y0, x1, y1) {
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
    this.n = null; this.kids = null; this.q = 0; this.cx = 0; this.cy = 0; this.count = 0;
  }
  Quad.prototype.insert = function (n, depth) {
    if (!this.kids && !this.n && !this.count) { this.n = n; this.count = 1; return; }
    if (!this.kids) {
      if (depth > 24) { this.count++; this.extra = (this.extra || []); this.extra.push(n); return; }
      var mx = (this.x0 + this.x1) / 2, my = (this.y0 + this.y1) / 2;
      this.kids = [new Quad(this.x0, this.y0, mx, my), new Quad(mx, this.y0, this.x1, my), new Quad(this.x0, my, mx, this.y1), new Quad(mx, my, this.x1, this.y1)];
      var old = this.n; this.n = null;
      if (old) this.child(old).insert(old, depth + 1);
    }
    this.count++;
    this.child(n).insert(n, depth + 1);
  };
  Quad.prototype.child = function (n) {
    var mx = (this.x0 + this.x1) / 2, my = (this.y0 + this.y1) / 2;
    return this.kids[(n.x >= mx ? 1 : 0) + (n.y >= my ? 2 : 0)];
  };
  Quad.prototype.accumulate = function () {
    var q = 0, cx = 0, cy = 0;
    if (this.kids) {
      for (var i = 0; i < 4; i++) {
        var k = this.kids[i];
        if (!k.count) continue;
        k.accumulate();
        q += k.q; cx += k.cx * k.q; cy += k.cy * k.q;
      }
    } else if (this.n) {
      q = this.n.charge; cx = this.n.x * q; cy = this.n.y * q;
      if (this.extra) this.extra.forEach(function (m) { q += m.charge; cx += m.x * m.charge; cy += m.y * m.charge; });
    }
    this.q = q;
    this.cx = q ? cx / q : (this.x0 + this.x1) / 2;
    this.cy = q ? cy / q : (this.y0 + this.y1) / 2;
  };
  Quad.prototype.find = function (x, y, r, best) {
    if (x + r < this.x0 || x - r > this.x1 || y + r < this.y0 || y - r > this.y1 || !this.count) return best;
    var check = function (n) {
      if (!n.vis) return;
      var dx = n.x - x, dy = n.y - y, d = Math.sqrt(dx * dx + dy * dy) - n.r;
      if (d < r && (!best || d < best.d)) best = { n: n, d: d };
    };
    if (this.n) check(this.n);
    if (this.extra) this.extra.forEach(check);
    if (this.kids) for (var i = 0; i < 4; i++) best = this.kids[i].find(x, y, r, best);
    return best;
  };

  /* ------------------------------------------------------------- engine --- */

  function Graph(root) {
    var self = this;
    this.root = root;
    this.kind = root.getAttribute("data-kind") || "claude";
    this.src = root.getAttribute("data-src");
    this.searchUrl = root.getAttribute("data-search");
    this.poll = Math.max(5000, parseInt(root.getAttribute("data-poll"), 10) || 15000);
    this.incremental = root.getAttribute("data-incremental") === "1";
    this.group = root.getAttribute("data-group") || "";
    this.nodes = []; this.byId = new Map(); this.edges = []; this.edgeKeys = new Set();
    this.cam = { x: 0, y: 0, k: 1 }; this.camTo = null;
    this.alpha = 1; this.alphaMin = 0.004; this.alphaTarget = 0;
    this.solo = null; this.query = ""; this.matched = null; this.meaning = false;
    this.showSem = true; this.hover = null; this.selected = null;
    this.running = false; this.raf = 0; this.dirty = true; this.cursor = null; this.loaded = false;
    this.frameMs = []; this.tickMs = [];
    this.stage = root.querySelector(".mg-stage");
    this.canvas = root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.countEl = root.querySelector(".mg-count");
    this.statusEl = root.querySelector(".mg-status");
    this.tipEl = root.querySelector(".mg-tip");
    this.detailEl = root.querySelector(".mg-detail");
    this.typesEl = root.querySelector(".mg-types");
    this.legendEl = root.querySelector(".mg-legend");
    this.input = root.querySelector(".mg-search input");
    this.sprites = {};
    this.repalette();
    this.resize();
    this.bind();
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); self.wake(); }).observe(this.stage);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) self.wake(); });
    document.addEventListener("joya-theme", function () { setTimeout(function () { self.repalette(); self.wake(); }, 0); });
    this.load();
  }

  Graph.prototype.repalette = function () {
    var cs = getComputedStyle(document.documentElement);
    var pal = {};
    ["--g-edge", "--g-edge-sem", "--warn", "--ink", "--muted", "--panel", "--accent", "--bg", "--line-strong", "--body"].forEach(function (k) {
      pal[k] = cs.getPropertyValue(k).trim();
    });
    TYPES.forEach(function (t) { pal[t[2]] = cs.getPropertyValue(t[2]).trim() || pal["--accent"]; });
    this.pal = pal;
    this.sprites = {};
    this.font = (cs.getPropertyValue("--brand-font") || cs.getPropertyValue("--ui") || "system-ui, sans-serif").trim();
  };

  Graph.prototype.color = function (n) { return this.pal[typeOf(n.t).token] || this.pal["--accent"]; };

  /** A soft glow, drawn once per colour and stamped under every hub. */
  Graph.prototype.sprite = function (color) {
    if (this.sprites[color]) return this.sprites[color];
    var s = 128, c = document.createElement("canvas");
    c.width = c.height = s;
    var g = c.getContext("2d");
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, color); grd.addColorStop(1, "transparent");
    g.globalAlpha = 0.45; g.fillStyle = grd; g.fillRect(0, 0, s, s);
    this.sprites[color] = c;
    return c;
  };

  Graph.prototype.resize = function () {
    var r = this.stage.getBoundingClientRect();
    var wasHidden = !(this.W > 2 && this.H > 2);
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    // Laid out while its panel was hidden: frame it now that there is room.
    if (wasHidden && this.W > 2 && this.H > 2 && this.loaded) {
      var self = this;
      setTimeout(function () { self.fit(self.matched, true); }, 0);
    }
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.dirty = true;
  };

  /* ------------------------------------------------------------ data --- */

  Graph.prototype.load = function (full) {
    var self = this;
    var url = this.src;
    var inc = this.loaded && this.incremental && !full && this.cursor;
    if (inc) url += (url.indexOf("?") < 0 ? "?" : "&") + "after_f=" + (this.cursor.f || 0) + "&after_c=" + (this.cursor.c || 0);
    if (!this.loaded) this.setStatus("Loading memories…");
    return getJSON(url)
      .then(function (d) {
        var added = self.merge(d, !inc);
        if (d.cursor) self.cursor = d.cursor;
        if (!self.loaded) {
          self.loaded = true;
          self.root.classList.add("mg-ready");
          self.setStatus(d.errors && d.errors.length ? d.errors.map(function (e) { return e.agent + ": " + e.error; }).join(" · ") : "");
          self.settle();
        } else if (added) {
          self.setStatus(added + " new " + (added === 1 ? "memory" : "memories"), 4000);
        }
        self.renderTypes();
        self.applyFilters(!self.loaded);
      })
      .catch(function (e) {
        self.setStatus("Could not load the graph: " + e.message);
      })
      .then(function () {
        clearTimeout(self.pollTimer);
        self.pollTimer = setTimeout(function () { self.tickPoll(); }, self.poll);
      });
  };

  Graph.prototype.tickPoll = function () {
    var self = this;
    if (document.hidden || !this.onScreen()) {
      clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(function () { self.tickPoll(); }, this.poll);
      return;
    }
    this.load(false);
  };

  Graph.prototype.onScreen = function () {
    return this.root.offsetParent !== null && !this.root.closest("[hidden]");
  };

  /** Fold new data in: add what is new, update what changed, retire what went. */
  Graph.prototype.merge = function (d, full) {
    var self = this, now = performance.now(), added = 0;
    var incoming = new Set();
    (d.nodes || []).forEach(function (raw) {
      incoming.add(raw.id);
      var n = self.byId.get(raw.id);
      if (n) {
        n.l = raw.l; n.s = raw.s; n.m = raw.m || n.m; n.ts = raw.ts || n.ts; n.g = raw.g === undefined ? n.g : raw.g;
        n.dying = 0;
        return;
      }
      n = { id: raw.id, t: raw.t, l: raw.l || "", s: raw.s || "", g: raw.g == null ? null : raw.g, h: !!raw.h, ts: raw.ts, m: raw.m || {},
        x: NaN, y: NaN, vx: 0, vy: 0, deg: 0, adj: [], born: self.loaded ? now : 0, vis: true, r: 3, charge: -30 };
      self.nodes.push(n);
      self.byId.set(n.id, n);
      if (self.loaded && !n.h) added++;
    });
    (d.edges || []).forEach(function (e) {
      var a = self.byId.get(e[0]), b = self.byId.get(e[1]);
      if (!a || !b || a === b) return;
      var key = e[0] < e[1] ? e[0] + "|" + e[1] + "|" + e[2] : e[1] + "|" + e[0] + "|" + e[2];
      if (self.edgeKeys.has(key)) return;
      self.edgeKeys.add(key);
      self.edges.push({ a: a, b: b, k: e[2], w: e[3] });
      a.adj.push(b); b.adj.push(a);
      if (e[2] !== "m") { a.deg++; b.deg++; }
    });
    // What is gone: a forgotten fact (Claude Code sends the ids still alive), or
    // anything a full refresh no longer carries.
    var alive = d.alive ? new Set(d.alive) : null;
    this.nodes.forEach(function (n) {
      var gone = (alive && n.id.charAt(0) === "f" && !alive.has(n.id)) || (full && self.loaded && d.full && !incoming.has(n.id));
      if (gone && !n.dying) n.dying = now;
    });
    // Place the newcomers: beside something they link to, else near their group.
    this.nodes.forEach(function (n) {
      if (!isNaN(n.x)) return;
      var anchor = null;
      for (var i = 0; i < n.adj.length; i++) if (!isNaN(n.adj[i].x)) { anchor = n.adj[i]; break; }
      var spread = anchor ? 18 + Math.random() * 14 : 60 + Math.sqrt(self.nodes.length) * 8;
      var a = Math.random() * TAU;
      n.x = (anchor ? anchor.x : 0) + Math.cos(a) * spread * (anchor ? 1 : Math.random());
      n.y = (anchor ? anchor.y : 0) + Math.sin(a) * spread * (anchor ? 1 : Math.random());
    });
    this.nodes.forEach(function (n) {
      n.r = n.h ? Math.min(22, 3.6 + Math.sqrt(n.deg) * 1.7) + (n.t === "project" || n.t === "agent" ? 5 : 0) : 3.4 + Math.min(2, n.deg * 0.25);
      n.charge = n.h ? -70 - Math.min(320, n.deg * 4) : -40;
    });
    if (this.loaded) this.reheat(added ? 0.35 : 0.08);
    this.dirty = true;
    return added;
  };

  Graph.prototype.forget = function (n) {
    this.byId.delete(n.id);
    this.edges = this.edges.filter(function (e) { return e.a !== n && e.b !== n; });
    var keys = new Set();
    this.edges.forEach(function (e) { keys.add(e.a.id < e.b.id ? e.a.id + "|" + e.b.id + "|" + e.k : e.b.id + "|" + e.a.id + "|" + e.k); });
    this.edgeKeys = keys;
    n.adj.forEach(function (m) { m.adj = m.adj.filter(function (x) { return x !== n; }); });
    this.nodes = this.nodes.filter(function (x) { return x !== n; });
    if (this.selected === n) this.select(null);
    if (this.hover === n) this.hover = null;
  };

  /* ------------------------------------------------------------ layout --- */

  Graph.prototype.reheat = function (a) {
    if (reduced.matches) { this.settleSync(120); return; }
    this.alpha = Math.max(this.alpha, a);
    this.wake();
  };

  Graph.prototype.tick = function () {
    var t0 = performance.now();
    var nodes = this.nodes, alpha = this.alpha, i, n;
    if (!nodes.length) return;
    // repulsion
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y; if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y;
    }
    var size = Math.max(x1 - x0, y1 - y0) + 1;
    var qt = new Quad(x0 - 1, y0 - 1, x0 + size + 1, y0 + size + 1);
    for (i = 0; i < nodes.length; i++) qt.insert(nodes[i], 0);
    qt.accumulate();
    this.qt = qt;
    var theta2 = 0.81;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.fixed) continue;
      applyBH(qt, n, alpha, theta2);
    }
    // springs
    var edges = this.edges;
    for (i = 0; i < edges.length; i++) {
      var e = edges[i], a = e.a, b = e.b;
      var L = e.k === "m" ? 60 : a.h && b.h ? 70 : a.h || b.h ? 18 + Math.max(a.r, b.r) * 1.3 : 26;
      var s = e.k === "m" ? 0.04 : (e.k === "v" ? 0.6 : 1) / Math.max(1, Math.min(a.deg, b.deg));
      var dx = b.x + b.vx - a.x - a.vx, dy = b.y + b.vy - a.y - a.vy;
      var l = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var f = ((l - L) / l) * alpha * s;
      var bias = a.deg / Math.max(1, a.deg + b.deg);
      dx *= f; dy *= f;
      if (!b.fixed) { b.vx -= dx * bias; b.vy -= dy * bias; }
      if (!a.fixed) { a.vx += dx * (1 - bias); a.vy += dy * (1 - bias); }
    }
    // centre, then integrate with friction
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.fixed) { n.vx = n.vy = 0; continue; }
      // a gentle pull to the middle keeps loose islands (a project with a
      // handful of memories) in the frame instead of drifting to its edge
      var gk = n.adj.length ? 0.02 : 0.04;
      n.vx -= n.x * gk * alpha; n.vy -= n.y * gk * alpha;
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += n.vx; n.y += n.vy;
    }
    this.alpha += (this.alphaTarget - this.alpha) * 0.0228;
    this.tickMs.push(performance.now() - t0);
    if (this.tickMs.length > 60) this.tickMs.shift();
  };

  function applyBH(cell, n, alpha, theta2) {
    if (!cell.count) return;
    var dx = cell.cx - n.x, dy = cell.cy - n.y, d2 = dx * dx + dy * dy;
    var w = cell.x1 - cell.x0;
    if (cell.kids && (w * w) / theta2 >= d2) {
      for (var i = 0; i < 4; i++) applyBH(cell.kids[i], n, alpha, theta2);
      return;
    }
    if (!cell.kids) {
      // a leaf: act body by body (skipping ourselves)
      var bodies = cell.extra ? [cell.n].concat(cell.extra) : [cell.n];
      for (var j = 0; j < bodies.length; j++) {
        var m = bodies[j];
        if (!m || m === n) continue;
        var ex = m.x - n.x, ey = m.y - n.y, e2 = ex * ex + ey * ey;
        if (e2 === 0) { ex = (Math.random() - 0.5) * 1e-3; ey = (Math.random() - 0.5) * 1e-3; e2 = ex * ex + ey * ey; }
        if (e2 < 1) e2 = Math.sqrt(e2);
        var f = (m.charge * alpha) / e2;
        n.vx += ex * f; n.vy += ey * f;
      }
      return;
    }
    if (d2 < 1) d2 = Math.sqrt(d2);
    var fc = (cell.q * alpha) / d2;
    n.vx += dx * fc; n.vy += dy * fc;
  }

  /** Run the layout to rest without drawing: first paint, and reduced motion. */
  Graph.prototype.settleSync = function (ticks) {
    for (var i = 0; i < ticks && this.alpha > this.alphaMin; i++) this.tick();
    if (reduced.matches) this.alpha = 0;
    this.dirty = true;
    this.wake();
  };

  Graph.prototype.settle = function () {
    // Enough ticks up front that the first frame is a shape, not a scatter.
    var n = this.nodes.length;
    var pre = reduced.matches ? 400 : n > 1500 ? 160 : 220;
    this.alpha = 1;
    this.settleSync(pre);
    this.fit(null, true);
  };

  /* ----------------------------------------------------------- filters --- */

  Graph.prototype.applyFilters = function (refit) {
    var g = this.group, solo = this.solo, i, n;
    var filtering = !!(g || solo);
    for (i = 0; i < this.nodes.length; i++) {
      n = this.nodes[i];
      var okGroup = !g || n.g === g || n.g == null;
      var okType = !solo || n.t === solo || n.h;
      n.vis = okGroup && okType;
    }
    if (filtering) {
      // A hub stays only while something it holds is showing.
      for (i = 0; i < this.nodes.length; i++) {
        n = this.nodes[i];
        if (!n.h || !n.vis || n.t === solo) continue;
        var any = false;
        for (var j = 0; j < n.adj.length; j++) if (n.adj[j].vis && (!n.adj[j].h || n.adj[j].t === solo)) { any = true; break; }
        if (!any && !(n.g === g && (n.t === "project" || n.t === "agent"))) n.vis = false;
      }
    }
    this.updateCount();
    this.dirty = true;
    if (refit) this.fit(null, false);
    this.wake();
  };

  Graph.prototype.updateCount = function () {
    var mem = 0, links = 0;
    this.nodes.forEach(function (n) { if (n.vis && !n.h && !n.dying) mem++; });
    var sem = this.showSem;
    this.edges.forEach(function (e) { if (e.a.vis && e.b.vis && (sem || e.k !== "m")) links++; });
    if (this.countEl) this.countEl.textContent = mem.toLocaleString("en-US") + " memories · " + links.toLocaleString("en-US") + " links";
  };

  Graph.prototype.renderTypes = function () {
    var self = this;
    if (!this.typesEl) return;
    var counts = {}, total = 0;
    this.nodes.forEach(function (n) {
      if (n.dying) return;
      counts[n.t] = (counts[n.t] || 0) + 1;
      if (!n.h) total++;
    });
    var list = this.typesEl.querySelector("ul") || this.typesEl.appendChild(el("ul"));
    list.textContent = "";
    var mk = function (key, label, count, token) {
      var li = el("li");
      var b = el("button", "mg-type");
      b.type = "button";
      b.setAttribute("data-type", key || "");
      b.setAttribute("aria-pressed", String((self.solo || "") === (key || "")));
      var dot = el("span", "mg-dot");
      if (token) dot.setAttribute("data-token", token);
      else dot.classList.add("all");
      b.appendChild(dot);
      b.appendChild(el("span", "mg-type-l", label));
      b.appendChild(el("span", "mg-type-n", count.toLocaleString("en-US")));
      li.appendChild(b);
      list.appendChild(li);
    };
    mk("", "All memories", total, null);
    TYPES.forEach(function (t) { if (counts[t[0]]) mk(t[0], t[1], counts[t[0]], t[2]); });
    this.paintDots(list);
    // the legend under the canvas: the same types, as a key
    if (this.legendEl) {
      this.legendEl.textContent = "";
      TYPES.forEach(function (t) {
        if (!counts[t[0]]) return;
        var s = el("span", "mg-leg");
        var d = el("i", "mg-dot");
        d.setAttribute("data-token", t[2]);
        s.appendChild(d);
        s.appendChild(document.createTextNode(t[1]));
        self.legendEl.appendChild(s);
      });
      this.paintDots(this.legendEl);
    }
  };

  /** Colour the little dots from the same tokens the canvas uses (CSSOM, not markup). */
  Graph.prototype.paintDots = function (scope) {
    var pal = this.pal;
    Array.prototype.forEach.call(scope.querySelectorAll(".mg-dot[data-token]"), function (d) {
      d.style.background = pal[d.getAttribute("data-token")] || "";
    });
  };

  /* ------------------------------------------------------------ camera --- */

  Graph.prototype.fit = function (set, instant) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
    var take = function (n) {
      if (!n.vis || n.dying) return;
      count++;
      if (n.x - n.r < x0) x0 = n.x - n.r; if (n.y - n.r < y0) y0 = n.y - n.r;
      if (n.x + n.r > x1) x1 = n.x + n.r; if (n.y + n.r > y1) y1 = n.y + n.r;
    };
    if (set && set.size) set.forEach(function (id) { var n = this.byId.get(id); if (n) take(n); }, this);
    else this.nodes.forEach(take);
    if (!count) return;
    var pad = 60;
    var k = Math.min((this.W - pad * 2) / Math.max(40, x1 - x0), (this.H - pad * 2) / Math.max(40, y1 - y0));
    k = Math.max(0.08, Math.min(set && set.size ? 2.6 : 2.2, k));
    var to = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: k };
    this.moveTo(to, instant);
  };

  Graph.prototype.moveTo = function (to, instant) {
    if (instant || reduced.matches) { this.cam = to; this.camTo = null; }
    else this.camTo = { from: { x: this.cam.x, y: this.cam.y, k: this.cam.k }, to: to, t0: performance.now(), d: 450 };
    this.dirty = true;
    this.wake();
  };

  Graph.prototype.zoomBy = function (f, sx, sy) {
    var cx = sx == null ? this.W / 2 : sx, cy = sy == null ? this.H / 2 : sy;
    var w = this.toWorld(cx, cy);
    var k = Math.max(0.05, Math.min(8, this.cam.k * f));
    // keep the point under the pointer where it is
    this.cam = { k: k, x: w.x - (cx - this.W / 2) / k, y: w.y - (cy - this.H / 2) / k };
    this.camTo = null;
    this.dirty = true;
    this.wake();
  };

  Graph.prototype.toWorld = function (sx, sy) {
    return { x: this.cam.x + (sx - this.W / 2) / this.cam.k, y: this.cam.y + (sy - this.H / 2) / this.cam.k };
  };

  /* ------------------------------------------------------------ render --- */

  Graph.prototype.wake = function () {
    if (this.running) return;
    var self = this;
    this.running = true;
    this.raf = requestAnimationFrame(function (t) { self.frame(t); });
  };

  Graph.prototype.frame = function (now) {
    this.running = false;
    if (document.hidden || !this.onScreen()) return; // sleeps until something wakes it
    var busy = false;
    if (this.alpha > this.alphaMin && !reduced.matches) { this.tick(); busy = true; this.dirty = true; }
    if (this.camTo) {
      var p = Math.min(1, (now - this.camTo.t0) / this.camTo.d), e = 1 - Math.pow(1 - p, 3);
      var f = this.camTo.from, to = this.camTo.to;
      this.cam = { x: f.x + (to.x - f.x) * e, y: f.y + (to.y - f.y) * e, k: f.k * Math.pow(to.k / f.k, e) };
      if (p >= 1) this.camTo = null;
      busy = true; this.dirty = true;
    }
    var self = this, anim = false;
    this.nodes.slice().forEach(function (n) {
      if (n.born && now - n.born < 1800) anim = true;
      if (n.dying) {
        if (now - n.dying > 700) self.forget(n);
        else anim = true;
      }
    });
    if (anim) { busy = true; this.dirty = true; }
    if (this.dirty) {
      var t0 = performance.now();
      this.draw(now);
      this.frameMs.push(performance.now() - t0);
      if (this.frameMs.length > 120) this.frameMs.shift();
      this.dirty = false;
    }
    if (busy) this.wake();
    else this.updateCount();
  };

  Graph.prototype.draw = function (now) {
    var ctx = this.ctx, pal = this.pal, cam = this.cam, W = this.W, H = this.H, k = cam.k;
    var self = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(k, k);
    ctx.translate(-cam.x, -cam.y);
    var vx0 = cam.x - W / 2 / k - 30, vx1 = cam.x + W / 2 / k + 30, vy0 = cam.y - H / 2 / k - 30, vy1 = cam.y + H / 2 / k + 30;
    var inView = function (n) { return n.x > vx0 && n.x < vx1 && n.y > vy0 && n.y < vy1; };
    var focus = this.selected || this.hover;
    var hl = this.matched;
    var dimOn = !!(hl || focus);
    var near = null;
    if (focus) { near = new Set([focus]); focus.adj.forEach(function (m) { near.add(m); }); }
    var lit = function (n) { return (!hl || hl.has(n.id)) && (!near || near.has(n)); };

    // links, batched by kind
    var batches = { s: new Path2D(), m: new Path2D(), v: new Path2D(), hot: new Path2D() };
    var anyHot = false;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i], a = e.a, b = e.b;
      if (!a.vis || !b.vis) continue;
      if (e.k === "m" && !this.showSem) continue;
      if (!inView(a) && !inView(b)) continue;
      var hot = focus && (a === focus || b === focus);
      var path = hot ? batches.hot : batches[e.k] || batches.s;
      if (hot) anyHot = true;
      path.moveTo(a.x, a.y); path.lineTo(b.x, b.y);
    }
    ctx.lineWidth = 1 / k;
    ctx.globalAlpha = dimOn ? 0.35 : 1;
    ctx.strokeStyle = pal["--g-edge"]; ctx.stroke(batches.s);
    ctx.setLineDash([4 / k, 4 / k]);
    ctx.strokeStyle = pal["--g-edge-sem"]; ctx.stroke(batches.m);
    ctx.setLineDash([]);
    ctx.strokeStyle = pal["--warn"]; ctx.lineWidth = 1.4 / k; ctx.stroke(batches.v);
    ctx.globalAlpha = 1;
    if (anyHot) { ctx.strokeStyle = pal["--accent"]; ctx.lineWidth = 1.6 / k; ctx.stroke(batches.hot); }

    // hub halos
    this.nodes.forEach(function (n) {
      if (!n.vis || !n.h || !inView(n)) return;
      var big = n.t === "project" || n.t === "agent";
      var R = n.r * (big ? 4.2 : 2.6);
      ctx.globalAlpha = (dimOn && !lit(n) ? 0.12 : 1) * (big ? 1 : 0.55) * self.grow(n, now);
      ctx.drawImage(self.sprite(self.color(n)), n.x - R, n.y - R, R * 2, R * 2);
    });
    ctx.globalAlpha = 1;

    // nodes, batched per colour (dimmed ones in a second pass)
    var byColor = {};
    this.nodes.forEach(function (n) {
      if (!n.vis || !inView(n)) return;
      var c = self.color(n) + (dimOn && !lit(n) ? "|dim" : "");
      var g = self.grow(n, now);
      if (g <= 0) return;
      (byColor[c] = byColor[c] || new Path2D());
      byColor[c].moveTo(n.x + n.r * g, n.y);
      byColor[c].arc(n.x, n.y, n.r * g, 0, TAU);
    });
    Object.keys(byColor).forEach(function (key) {
      var parts = key.split("|");
      ctx.globalAlpha = parts[1] ? 0.14 : 1;
      ctx.fillStyle = parts[0];
      ctx.fill(byColor[key]);
    });
    ctx.globalAlpha = 1;
    // hub rings (the "O" inside a hub), superseded marks, and the pulse on newcomers
    this.nodes.forEach(function (n) {
      if (!n.vis || !inView(n)) return;
      var dim = dimOn && !lit(n);
      if (n.h && n.r > 7.5) {
        ctx.globalAlpha = dim ? 0.2 : 0.85;
        ctx.strokeStyle = pal["--bg"]; ctx.lineWidth = Math.max(1.2, n.r * 0.16);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.5, 0, TAU); ctx.stroke();
      }
      if (n.m && n.m.sup && !n.h) {
        ctx.globalAlpha = dim ? 0.2 : 0.9;
        ctx.strokeStyle = pal["--warn"]; ctx.lineWidth = 1 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 1.6 / k, 0, TAU); ctx.stroke();
      }
      if (n.born && now - n.born < 1800) {
        var p = (now - n.born) / 1800;
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = pal["--accent"]; ctx.lineWidth = 2 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (4 + 26 * p) / Math.max(0.6, k), 0, TAU); ctx.stroke();
      }
      if (n === self.selected || (hl && hl.has(n.id))) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = pal["--ink"]; ctx.lineWidth = (n === self.selected ? 2.2 : 1.4) / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 / k, 0, TAU); ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawLabels(now, inView, dimOn, lit);
  };

  /** 0 to 1: how far a newcomer has grown in (with a little overshoot), and a fade for the departing. */
  Graph.prototype.grow = function (n, now) {
    if (n.dying) return Math.max(0, 1 - (now - n.dying) / 700);
    if (!n.born || reduced.matches) return 1;
    var p = Math.min(1, (now - n.born) / 650);
    var c = 1.70158;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
  };

  Graph.prototype.drawLabels = function (now, inView, dimOn, lit) {
    var ctx = this.ctx, pal = this.pal, cam = this.cam, W = this.W, H = this.H, k = cam.k, self = this;
    var cand = [];
    var hl = this.matched;
    this.nodes.forEach(function (n) {
      if (!n.vis || n.dying || !inView(n) || !n.l) return;
      var pri = -1;
      if (n === self.selected) pri = 100;
      else if (n === self.hover) pri = 90;
      else if (hl && hl.has(n.id)) pri = 70 + Math.min(10, n.deg);
      else if (n.h && (n.t === "project" || n.t === "agent")) pri = k > 0.12 ? 60 : -1;
      else if (n.h) pri = k * n.r > 1.4 || n.deg > 20 ? 30 + Math.min(25, n.deg / 4) : -1;
      else if (k > 1.5) pri = 32;
      if (dimOn && !lit(n) && pri < 70) pri = -1;
      if (pri >= 0) cand.push([pri, n]);
    });
    cand.sort(function (a, b) { return b[0] - a[0]; });
    var cell = 14, grid = new Set(), placed = 0, limit = 320;
    var occupied = function (x0, y0, x1, y1, mark) {
      for (var gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
        for (var gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
          var key = gx + "," + gy;
          if (mark) grid.add(key);
          else if (grid.has(key)) return true;
        }
      return false;
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    for (var i = 0; i < cand.length && placed < limit; i++) {
      var n = cand[i][1], pri = cand[i][0];
      var sx = (n.x - cam.x) * k + W / 2, sy = (n.y - cam.y) * k + H / 2;
      var big = n.t === "project" || n.t === "agent";
      var size = big ? 13 : n.h ? 11.5 : 11;
      ctx.font = (big ? "700 " : n.h ? "650 " : "500 ") + size + "px " + this.font;
      var text = n.l.length > 42 && pri < 90 ? n.l.slice(0, 40) + "…" : n.l;
      ctx.direction = dirOf(text);
      var w = ctx.measureText(text).width;
      var ty = sy + n.r * k + 3;
      var box = [sx - w / 2 - 2, ty - 1, sx + w / 2 + 2, ty + size + 2];
      if (pri < 90 && occupied(box[0], box[1], box[2], box[3], false)) continue;
      occupied(box[0], box[1], box[2], box[3], true);
      ctx.globalAlpha = this.grow(n, now);
      ctx.strokeStyle = pal["--panel"]; ctx.lineWidth = 3.5;
      ctx.strokeText(text, sx, ty);
      ctx.fillStyle = big ? this.color(n) : n.h ? pal["--ink"] : pal["--body"];
      ctx.fillText(text, sx, ty);
      placed++;
    }
    ctx.globalAlpha = 1;
    ctx.direction = "ltr";
  };

  /* ------------------------------------------------------- interaction --- */

  Graph.prototype.pick = function (sx, sy) {
    if (!this.qt) return null;
    var w = this.toWorld(sx, sy);
    var hit = this.qt.find(w.x, w.y, 6 / this.cam.k, null);
    return hit ? hit.n : null;
  };

  Graph.prototype.bind = function () {
    var self = this, cv = this.canvas, drag = null;
    cv.setAttribute("tabindex", "0");
    var pos = function (ev) { var r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    cv.addEventListener("pointerdown", function (ev) {
      var p = pos(ev), n = self.pick(p.x, p.y);
      drag = { x: p.x, y: p.y, n: n, moved: false, cam: { x: self.cam.x, y: self.cam.y } };
      cv.setPointerCapture(ev.pointerId);
      if (n) { n.fixed = true; }
    });
    cv.addEventListener("pointermove", function (ev) {
      var p = pos(ev);
      if (drag) {
        var dx = p.x - drag.x, dy = p.y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.n) {
          var w = self.toWorld(p.x, p.y);
          drag.n.x = w.x; drag.n.y = w.y;
          if (drag.moved) self.reheat(0.12);
        } else if (drag.moved) {
          self.cam = { x: drag.cam.x - dx / self.cam.k, y: drag.cam.y - dy / self.cam.k, k: self.cam.k };
          self.camTo = null;
        }
        self.dirty = true;
        self.wake();
        return;
      }
      var n = self.pick(p.x, p.y);
      if (n !== self.hover) {
        self.hover = n;
        cv.style.cursor = n ? "pointer" : "grab";
        self.showTip(n, p);
        self.dirty = true;
        self.wake();
      } else if (n) self.showTip(n, p);
    });
    var end = function (ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.n) d.n.fixed = false;
      if (!d.moved) self.select(d.n);
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", function () { if (!drag && self.hover) { self.hover = null; self.showTip(null); self.dirty = true; self.wake(); } });
    cv.addEventListener("dblclick", function (ev) {
      var p = pos(ev), n = self.pick(p.x, p.y);
      var href = n && self.hrefFor(n);
      if (href) window.location.href = href;
    });
    cv.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var p = pos(ev);
      self.zoomBy(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0016)), p.x, p.y);
    }, { passive: false });

    this.root.addEventListener("click", function (ev) {
      var z = ev.target.closest("[data-zoom]");
      if (z) {
        var how = z.getAttribute("data-zoom");
        if (how === "in") self.zoomBy(1.35);
        else if (how === "out") self.zoomBy(1 / 1.35);
        else self.fit(self.matched, false);
        return;
      }
      var t = ev.target.closest(".mg-type");
      if (t) {
        var key = t.getAttribute("data-type") || null;
        self.solo = self.solo === key ? null : key;
        Array.prototype.forEach.call(self.root.querySelectorAll(".mg-type"), function (b) {
          b.setAttribute("aria-pressed", String((b.getAttribute("data-type") || null) === self.solo));
        });
        self.applyFilters(true);
        return;
      }
      var chip = ev.target.closest("[data-group-chip]");
      if (chip) {
        ev.preventDefault();
        self.setGroup(chip.getAttribute("data-group-chip"));
        return;
      }
      var go = ev.target.closest("[data-node]");
      if (go) {
        ev.preventDefault();
        var n = self.byId.get(go.getAttribute("data-node"));
        if (n) { self.select(n); self.moveTo({ x: n.x, y: n.y, k: Math.max(self.cam.k, 1.6) }); }
        return;
      }
      if (ev.target.closest("[data-detail-close]")) self.select(null);
    });
    var sem = this.root.querySelector(".mg-related input");
    if (sem) sem.addEventListener("change", function () { self.showSem = sem.checked; self.updateCount(); self.dirty = true; self.wake(); });

    if (this.input) {
      var timer = 0;
      this.input.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { self.keyword(self.input.value); }, 220);
      });
      this.input.form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        self.byMeaning(self.input.value);
      });
      this.input.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") { self.input.value = ""; self.clearSearch(); self.input.blur(); }
      });
    }
    document.addEventListener("keydown", function (ev) {
      if (!self.onScreen() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var tag = (ev.target && ev.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable)) return;
      if (ev.key === "/") { ev.preventDefault(); if (self.input) self.input.focus(); }
      else if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); self.zoomBy(1.35); }
      else if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); self.zoomBy(1 / 1.35); }
      else if (ev.key === "0") { ev.preventDefault(); self.fit(self.matched, false); }
      else if (ev.key === "Escape") { self.clearSearch(); self.select(null); }
    });
  };

  Graph.prototype.setGroup = function (g) {
    this.group = g || "";
    Array.prototype.forEach.call(this.root.querySelectorAll("[data-group-chip]"), function (c) {
      c.setAttribute("aria-pressed", String((c.getAttribute("data-group-chip") || "") === (g || "")));
    });
    this.applyFilters(true);
  };

  Graph.prototype.showTip = function (n, p) {
    if (!this.tipEl) return;
    if (!n) { this.tipEl.hidden = true; return; }
    this.tipEl.textContent = "";
    var head = el("b", null, n.l);
    head.dir = "auto";
    this.tipEl.appendChild(el("span", "mg-tip-t", typeOf(n.t).label));
    this.tipEl.appendChild(head);
    if (n.m && n.m.topic) this.tipEl.appendChild(el("span", "mg-tip-s", n.m.topic));
    this.tipEl.hidden = false;
    var x = Math.min(this.W - 260, p.x + 14), y = Math.min(this.H - 60, p.y + 14);
    this.tipEl.style.left = Math.max(4, x) + "px";
    this.tipEl.style.top = Math.max(4, y) + "px";
  };

  /* ------------------------------------------------------------ search --- */

  Graph.prototype.setStatus = function (text, ms) {
    if (!this.statusEl) return;
    var self = this;
    this.statusEl.textContent = text || "";
    this.statusEl.hidden = !text;
    clearTimeout(this.statusTimer);
    if (ms) this.statusTimer = setTimeout(function () { if (self.statusEl.textContent === text) self.setStatus(""); }, ms);
  };

  Graph.prototype.keyword = function (q) {
    q = String(q || "").trim().toLowerCase();
    this.meaning = false;
    if (!q) { this.clearSearch(); return; }
    var hits = new Set();
    this.nodes.forEach(function (n) {
      if (!n.vis || n.dying) return;
      var hay = (n.l + " " + (n.s || "") + " " + ((n.m && (n.m.topic || n.m.path)) || "")).toLowerCase();
      if (hay.indexOf(q) >= 0) hits.add(n.id);
    });
    this.matched = hits;
    this.setStatus(hits.size ? hits.size + " match" + (hits.size === 1 ? "" : "es") + " · Enter to search by meaning" : "No keyword match · Enter to search by meaning");
    if (hits.size && hits.size <= 600) this.fit(hits, false);
    this.dirty = true;
    this.wake();
  };

  Graph.prototype.byMeaning = function (q) {
    var self = this;
    q = String(q || "").trim();
    if (!q || !this.searchUrl) return;
    this.setStatus("Searching by meaning…");
    var url = this.searchUrl + (this.searchUrl.indexOf("?") < 0 ? "?" : "&") + "q=" + encodeURIComponent(q);
    if (this.group) url += "&" + (this.kind === "agents" ? "agent" : "project") + "=" + encodeURIComponent(this.group);
    getJSON(url)
      .then(function (d) {
        var hits = new Set(), outside = 0;
        (d.hits || []).forEach(function (h) {
          var n = self.byId.get(h.id);
          if (n && !n.dying) { hits.add(h.id); n.vis = true; }
          else outside++;
        });
        self.meaning = true;
        self.matched = hits;
        self.setStatus(hits.size + " related by meaning" + (outside ? " · " + outside + " more outside the loaded graph" : "") + " · Esc to clear");
        if (hits.size) self.fit(hits, false);
        self.dirty = true;
        self.wake();
      })
      .catch(function (e) { self.setStatus("Search failed: " + e.message); });
  };

  Graph.prototype.clearSearch = function () {
    this.matched = null;
    this.meaning = false;
    this.setStatus("");
    this.applyFilters(false);
  };

  /* ------------------------------------------------------------ detail --- */

  Graph.prototype.hrefFor = function (n) {
    var m = n.m || {};
    if (m.fact) return "/claude/memory/facts/" + encodeURIComponent(m.fact);
    if (n.t === "session" && m.session) return "/claude/memory/session/" + encodeURIComponent(m.session);
    if (m.path && m.agent) return "/agents/" + encodeURIComponent(m.agent) + "/memory/note?path=" + encodeURIComponent(m.path);
    if (n.t === "agent" && m.agent) return "/agents/" + encodeURIComponent(m.agent);
    if (n.t === "topic" && m.topic) return "/claude/memory?view=list&topic=" + encodeURIComponent(m.topic);
    if (n.t === "project") return "/claude/memory?view=list&project=" + encodeURIComponent(n.l);
    if (m.chunk && m.session) return "/claude/memory/session/" + encodeURIComponent(m.session);
    return null;
  };

  Graph.prototype.select = function (n) {
    this.selected = n || null;
    this.dirty = true;
    this.wake();
    var d = this.detailEl;
    if (!d) return;
    if (!n) { d.hidden = true; this.root.classList.remove("mg-open"); return; }
    d.hidden = false;
    this.root.classList.add("mg-open");
    d.textContent = "";
    var head = el("div", "mg-d-head");
    var chip = el("span", "mg-d-type");
    var dot = el("i", "mg-dot");
    dot.setAttribute("data-token", typeOf(n.t).token);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(typeOf(n.t).label));
    head.appendChild(chip);
    var close = el("button", "mg-d-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.setAttribute("data-detail-close", "");
    head.appendChild(close);
    d.appendChild(head);
    this.paintDots(head);
    var title = el("h3", "mg-d-title", n.l);
    title.dir = "auto";
    d.appendChild(title);
    var meta = el("dl", "mg-d-meta");
    var row = function (k, v, mono) {
      if (v == null || v === "") return;
      meta.appendChild(el("dt", null, k));
      var dd = el("dd", mono ? "mono" : null, String(v));
      dd.dir = "auto";
      meta.appendChild(dd);
    };
    var m = n.m || {};
    row("Topic", m.topic, true);
    row(n.t === "agent" ? "Agent" : m.agent ? "Agent" : n.g ? "Project" : null, m.agent || n.g);
    row("When", fmtDate(n.ts), true);
    if (m.path) row("File", m.path, true);
    if (m.tags && m.tags.length) row("Tags", m.tags.map(function (t) { return "#" + t; }).join(" "));
    if (n.t === "session" && m.chunks) row("Chunks", m.chunks);
    d.appendChild(meta);
    var body = el("div", "mg-d-body");
    if (n.s) { var p = el("p", "mg-d-text", n.s); p.dir = "auto"; body.appendChild(p); }
    d.appendChild(body);
    var links = el("div", "mg-d-links");
    var href = this.hrefFor(n);
    if (href) {
      var a = el("a", "btn small", m.fact ? "Open fact" : m.path ? "Open note" : n.t === "session" ? "Open session memory" : n.t === "agent" ? "Open agent" : "Show in list");
      a.href = href;
      links.appendChild(a);
    }
    if (m.session && n.t !== "session") {
      var s = el("a", "btn small", "Session " + String(m.session).slice(0, 8));
      s.href = "/claude/memory/session/" + encodeURIComponent(m.session);
      links.appendChild(s);
    }
    d.appendChild(links);
    // neighbours, so the panel is a way to walk the graph
    var nb = n.adj.filter(function (x) { return !x.dying; }).slice(0, 14);
    if (nb.length) {
      d.appendChild(el("h4", "mg-d-sub", "Linked (" + n.adj.length + ")"));
      var ul = el("ul", "mg-d-nb");
      nb.forEach(function (x) {
        var li = el("li");
        var b = el("button", "mg-d-nbb");
        b.type = "button";
        b.setAttribute("data-node", x.id);
        var i2 = el("i", "mg-dot");
        i2.setAttribute("data-token", typeOf(x.t).token);
        b.appendChild(i2);
        var span = el("span", null, x.l);
        span.dir = "auto";
        b.appendChild(span);
        li.appendChild(b);
        ul.appendChild(li);
      });
      d.appendChild(ul);
      this.paintDots(ul);
    }
    this.enrich(n, body, d);
  };

  /** The full text, and the actions, fetched when a node is opened. */
  Graph.prototype.enrich = function (n, body, panel) {
    var self = this, m = n.m || {};
    var factUrl = this.root.getAttribute("data-fact-url");
    if (m.fact && factUrl) {
      getJSON(factUrl + encodeURIComponent(m.fact)).then(function (d) {
        if (self.selected !== n) return;
        var f = d.fact || {};
        body.textContent = "";
        var p = el("p", "mg-d-text full", f.content || n.s);
        p.dir = "auto";
        body.appendChild(p);
        var st = el("p", "mg-d-state");
        st.textContent = f.superseded_by == null ? "Current" : f.superseded_by === f.id ? "Forgotten" : "Superseded by #" + f.superseded_by;
        body.appendChild(st);
        if (self.root.getAttribute("data-writable") === "1" && f.superseded_by == null) self.factActions(f, panel);
      }).catch(function () { /* the snippet stays */ });
    }
    if (m.path && m.agent) {
      var url = "/api/agents/" + encodeURIComponent(m.agent) + "/memory/note?path=" + encodeURIComponent(m.path);
      getJSON(url).then(function (d) {
        if (self.selected !== n) return;
        body.textContent = "";
        var pre = el("pre", "mg-d-note", d.content + (d.truncated ? "\n…" : ""));
        pre.dir = "auto";
        body.appendChild(pre);
      }).catch(function () { /* the snippet stays */ });
    }
  };

  /** Edit (a new fact that supersedes this one) and Forget (with a reason): the page's own forms. */
  Graph.prototype.factActions = function (f, panel) {
    var csrf = this.root.getAttribute("data-csrf") || "";
    var kinds = ["decision", "figure", "trap", "preference", "open_issue", "fact"];
    var hidden = function (form) {
      var i = el("input");
      i.type = "hidden"; i.name = "_csrf"; i.value = csrf;
      form.appendChild(i);
    };
    var edit = el("details", "mg-d-act");
    edit.appendChild(el("summary", "btn small", "Edit (supersedes)"));
    var ef = el("form");
    ef.method = "post";
    ef.action = "/claude/memory/facts/" + encodeURIComponent(f.id) + "/edit";
    hidden(ef);
    var lab = el("label", null, "Fact");
    var ta = el("textarea");
    ta.name = "content"; ta.rows = 5; ta.maxLength = 4000; ta.required = true; ta.value = f.content || ""; ta.dir = "auto";
    lab.appendChild(ta);
    ef.appendChild(lab);
    var lt = el("label", null, "Topic");
    var ti = el("input");
    ti.name = "topic"; ti.required = true; ti.maxLength = 121; ti.value = f.topic || "";
    lt.appendChild(ti);
    ef.appendChild(lt);
    var lk = el("label", null, "Kind");
    var sel = el("select");
    sel.name = "kind";
    kinds.forEach(function (k) {
      var o = el("option", null, k);
      o.value = k;
      if (k === ((f.meta && f.meta.kind) || "fact")) o.selected = true;
      sel.appendChild(o);
    });
    lk.appendChild(sel);
    ef.appendChild(lk);
    var sb = el("button", "btn primary small", "Save as new version");
    sb.type = "submit";
    ef.appendChild(sb);
    edit.appendChild(ef);
    panel.appendChild(edit);

    var forget = el("details", "mg-d-act");
    forget.appendChild(el("summary", "btn small danger", "Forget"));
    var ff = el("form");
    ff.method = "post";
    ff.action = "/claude/memory/facts/" + encodeURIComponent(f.id) + "/forget";
    ff.setAttribute("data-confirm", "Forget fact #" + f.id + "? It will stop being recalled. It is kept in the database and can be seen with 'Include superseded'.");
    hidden(ff);
    var lr = el("label", null, "Reason");
    var ri = el("input");
    ri.name = "reason"; ri.required = true; ri.maxLength = 500; ri.placeholder = "out of date since …";
    lr.appendChild(ri);
    ff.appendChild(lr);
    var fb = el("button", "btn danger small", "Forget this fact");
    fb.type = "submit";
    ff.appendChild(fb);
    forget.appendChild(ff);
    panel.appendChild(forget);
  };

  /** Where a node is on screen (for tests and tooling), or null. */
  Graph.prototype.screenOf = function (id) {
    var n = this.byId.get(id);
    if (!n) return null;
    var r = this.canvas.getBoundingClientRect();
    return { x: r.left + (n.x - this.cam.x) * this.cam.k + this.W / 2, y: r.top + (n.y - this.cam.y) * this.cam.k + this.H / 2, vis: n.vis };
  };

  Graph.prototype.stats = function () {
    var avg = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; };
    var vis = this.nodes.filter(function (n) { return n.vis; }).length;
    return { nodes: this.nodes.length, visible: vis, edges: this.edges.length, frameMs: +avg(this.frameMs).toFixed(2),
      maxFrameMs: +Math.max.apply(null, this.frameMs.concat([0])).toFixed(2), tickMs: +avg(this.tickMs).toFixed(2), alpha: +this.alpha.toFixed(4),
      zoom: +this.cam.k.toFixed(3), matched: this.matched ? this.matched.size : 0 };
  };

  /* ------------------------------------------------------------- boot --- */

  var graphs = [];
  function mount(root) {
    if (root.__mg) return root.__mg;
    var g = new Graph(root);
    root.__mg = g;
    graphs.push(g);
    return g;
  }
  window.MemGraph = { mount: mount, graphs: graphs };

  // The page's view switch (Graph / List / Overview): tabs that show one panel
  // and remember the choice in the URL, so a reload lands where you were.
  function views() {
    var sw = document.querySelector("[data-view-switch]");
    if (!sw) return;
    sw.addEventListener("click", function (ev) {
      var a = ev.target.closest("[data-view]");
      if (!a) return;
      ev.preventDefault();
      var v = a.getAttribute("data-view");
      Array.prototype.forEach.call(sw.querySelectorAll("[data-view]"), function (b) {
        var on = b === a;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-view-panel]"), function (p) {
        p.hidden = p.getAttribute("data-view-panel") !== v;
      });
      try {
        var u = new URL(window.location.href);
        u.searchParams.set("view", v);
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      } catch (e) { /* the view still switched */ }
      mountVisible();
      graphs.forEach(function (g) { g.resize(); g.dirty = true; g.wake(); });
    });
  }

  // A graph starts (and fetches its data) only once its panel is shown: the organised
  // list is the default view now, and most visits never open the graph.
  function mountVisible() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-memgraph]"), function (root) {
      if (!root.closest("[hidden]") && !root.hasAttribute("hidden")) mount(root);
    });
  }

  function boot() {
    mountVisible();
    views();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
