/*
 * The living canvas's building blocks (2026-10-20): what a widget JOYA AI composes may be made of,
 * and the one validator that decides whether it is one. Pure: no DOM, no state, no network.
 *
 * The same file runs in three places, and each runs validate():
 *   - the supervisor (joya-ai/lib/joya-widgets.js, a byte-for-byte copy; tests check), on JOYA AI's
 *     ui_widget tool, before anything is emitted;
 *   - the dashboard (server.js uiDeliver, routes-canvas.js on a pin), before anything reaches a tab
 *     or is stored;
 *   - the page (joya-canvas.js), before anything is drawn.
 *
 * A widget is JSON, never markup: a kind, a title, and one to six blocks from a fixed, versioned set
 * (BLOCKS). It carries no HTML, script, style or URL -- no field takes one, an unknown field is an
 * error, and a string that holds a URL scheme ("x://", "javascript:") is refused. Its data is either
 * in the payload (bounded: MAX_BYTES, and per block) or named: a block's `view` of the widget's
 * `source`, one of a few read-only sources the dashboard already serves (SOURCES). A widget with a
 * source is live: the page refreshes it from that source.
 *
 *   JoyaWidgets.validate(spec)  -> { ok: true, value, key } | { ok: false, why, path }
 *   JoyaWidgets.learnKey(spec)  -> "chart:usage.spend" (what the board learns per person)
 *   JoyaWidgets.catalog()       -> the catalog JOYA AI reads (its ui_widgets_list tool)
 *   JoyaWidgets.VERSION, KINDS, BLOCKS, SOURCES, LIMITS
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JoyaWidgets = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = 1;
  var LIMITS = { MAX_BYTES: 12000, MAX_BLOCKS: 6, TITLE: 80, NOTE: 200, TEXT: 500, ROWS: 50, COLS: 8, ITEMS: 20, POINTS: 60, SERIES: 3, FILES: 50, CELL: 120 };

  /* What a widget is (the learning key's first half, and what the board shows on its header). */
  var KINDS = {
    chart: "A chart (spend, tokens, any series)",
    files: "Files touched, with lines added and removed (a diff summary)",
    table: "A table",
    approval: "A waiting approval, opening the existing decision card",
    compare: "Two sessions side by side",
    story: "A session's story card",
    metric: "One figure (a metric tile)",
    list: "A short list",
  };

  var TONES = ["ok", "warn", "err", "info"];
  var FORMATS = ["text", "number", "usd", "tokens", "pct", "time", "duration"];
  var UNITS = ["", "usd", "tokens", "count", "pct", "minutes"];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var KEY = /^[a-z][a-z0-9_]{0,23}$/;

  /*
   * The named sources. Each is read-only and already served to the Command Center:
   *   from  where the page reads it (an existing GET route, or the page's own live state);
   *   params the source's parameters (strict);
   *   views  name -> the block type it feeds, and what it shows.
   */
  var SOURCES = {
    "usage.spend": {
      label: "Spend (the Usage panel's cost report: JOYA AI and other sessions, last 14 days)",
      from: "GET /joya-ai/api/cost",
      params: {},
      views: {
        days: { block: "chart", what: "spend per day, 14 days: JOYA AI and other sessions (est.), in $" },
        today: { block: "metric", what: "today's spend in $" },
        sessions: { block: "table", what: "sessions by today's spend: name, today $, last 7 days $" },
        top: { block: "list", what: "the sessions that spent most today" },
      },
    },
    "usage.caps": {
      label: "Tokens today against the daily token caps (Settings > Usage)",
      from: "GET /joya-ai/api/caps",
      params: {},
      views: {
        tokens: { block: "metric", what: "tokens used today, all sessions" },
        tightest: { block: "metric", what: "the session nearest its cap, as a percent" },
        sessions: { block: "table", what: "each session's tokens today, its cap and the share used" },
        chart: { block: "chart", what: "tokens today per session (bars)" },
      },
    },
    sessions: {
      label: "The live sessions (the Command Center's own list)",
      from: "the page's live sessions",
      params: { state: ["any", "working", "waiting", "idle"] },
      views: {
        list: { block: "list", what: "the sessions (the state param filters), what each is doing" },
        table: { block: "table", what: "name, state, since, where" },
        working: { block: "metric", what: "how many are working" },
        waiting: { block: "metric", what: "how many wait on the administrator" },
      },
    },
    story: {
      label: "One session's story (the session story view's data)",
      from: "GET /joya-ai/api/sessions/:session/story",
      params: { session: "uuid" },
      views: {
        files: { block: "files", what: "the files it touched, lines added and removed" },
        tokens: { block: "metric", what: "its tokens" },
        active: { block: "metric", what: "its active time" },
        steps: { block: "list", what: "its plan's steps, done / now / next" },
        handoffs: { block: "list", what: "its hand-offs" },
      },
    },
    feed: {
      label: "The Command Center's live feed (event log)",
      from: "the page's event log",
      params: {},
      views: {
        alerts: { block: "list", what: "the recent events that matter (approvals, errors, watchers, sessions done)" },
        recent: { block: "list", what: "the newest events" },
      },
    },
    approvals: {
      label: "Approvals waiting on the administrator",
      from: "the page's live approvals",
      params: {},
      views: {
        pending: { block: "list", what: "the approvals waiting, soonest to run out first" },
        count: { block: "metric", what: "how many wait" },
      },
    },
  };

  /*
   * The blocks. `data` lists the fields a block takes when its data is in the payload; `view` is
   * the other way (a view of the widget's source that feeds this block type). story, compare and
   * approval name what they show and read it from their own source (story / approvals) -- their
   * text never comes from the payload, so a widget cannot dress up an approval.
   */
  var BLOCKS = {
    text: { what: "A short paragraph (plain text, no markup)", fields: { text: "string <= 500", tone: "ok|warn|err|info (optional)" } },
    metric: { what: "One figure with its label", fields: { label: "string <= 40", value: "number, or string <= 24", unit: "usd|tokens|count|pct|minutes|'' (optional)", hint: "string <= 80 (optional)", tone: "optional" }, view: true },
    chart: { what: "Bars or a line; up to 3 series of up to 60 points", fields: { style: "bar|line", unit: "optional", series: "[{label <= 40, points: [[x label <= 16, y number], ...]}]" }, view: true },
    table: { what: "Up to 8 columns and 50 rows", fields: { columns: "[{key: a-z0-9_ <= 24, label <= 32, align: left|right (optional), format: text|number|usd|tokens|pct|time|duration (optional)}]", rows: "[{<column key>: string <= 120 | number}]" }, view: true },
    list: { what: "Up to 20 items", fields: { items: "[{text <= 160, sub <= 120 (optional), tone (optional), session: session id (optional; links its story)}]" }, view: true },
    files: { what: "Files and their +/- lines (a diff summary)", fields: { files: "[{path <= 240, add: int, del: int}] (up to 50)" }, view: true },
    story: { what: "A session's story card (state, plan step, files, tokens); opens its story", fields: { session: "session id (uuid)" } },
    compare: { what: "Two sessions side by side (tokens, active time, files, turns)", fields: { sessions: "[session id, session id]" } },
    approval: { what: "A waiting approval as its real card shows it; buttons open the decision card (approving stays the administrator's, with the usual step-up)", fields: { approval: "approval id (int)" } },
  };

  /* Which blocks suit a kind (a kind's first block must be one of these; the rest may be text/metric/list). */
  var KIND_BLOCKS = {
    chart: ["chart"], files: ["files"], table: ["table"], approval: ["approval"], compare: ["compare"], story: ["story"], metric: ["metric"], list: ["list"],
  };

  /* ------------------------------------------------------------------ checks */
  function Bad(why, path) { this.why = why; this.path = path; }
  function fail(why, path) { throw new Bad(why, path); }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function only(o, allowed, path) {
    Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) fail("unknown field " + JSON.stringify(k.slice(0, 40)) + " (fields: " + allowed.join(", ") + ")", path); });
  }
  // A URL scheme anywhere, or markup: refused (nothing renders it, but nothing should even carry it).
  var SCHEME = /(?:^|[^a-z0-9])(?:[a-z][a-z0-9+.-]{1,20}:\/\/|javascript:|vbscript:|data:[a-z]+\/|file:\/)/i;
  function str(v, max, path, opt) {
    if (v === undefined || v === null || v === "") { if (opt) return ""; fail("required text", path); }
    if (typeof v !== "string") fail("must be text", path);
    var s = v.replace(/\r\n?/g, "\n").trim();
    if (!s && !opt) fail("required text", path);
    if (s.length > max) fail("longer than " + max + " characters", path);
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/.test(s)) fail("control characters", path);
    if (SCHEME.test(s)) fail("no URLs or schemes in a widget", path);
    if (/<[a-z!\/?]/i.test(s)) fail("no markup in a widget", path);
    return s;
  }
  function num(v, path) {
    if (typeof v !== "number" || !isFinite(v) || Math.abs(v) > 1e12) fail("must be a finite number", path);
    return Math.round(v * 1e6) / 1e6;
  }
  function int(v, min, max, path) {
    if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v < min || v > max) fail("must be a whole number " + min + "–" + max, path);
    return v;
  }
  function oneOf(v, list, path, opt) {
    if ((v === undefined || v === null || v === "") && opt) return opt === true ? "" : opt;
    if (typeof v !== "string" || list.indexOf(v) < 0) fail("must be one of " + list.filter(Boolean).join(", "), path);
    return v;
  }
  function arr(v, min, max, path) {
    if (!Array.isArray(v)) fail("must be a list", path);
    if (v.length < min) fail("needs at least " + min, path);
    if (v.length > max) fail("at most " + max, path);
    return v;
  }
  function uuid(v, path) {
    if (typeof v !== "string" || !UUID.test(v)) fail("must be a session id (a uuid)", path);
    return v;
  }

  function cleanSource(s, path) {
    if (!isObj(s)) fail("must be an object {name, params}", path);
    only(s, ["name", "params"], path);
    var name = oneOf(s.name, Object.keys(SOURCES), path + ".name");
    var def = SOURCES[name];
    var p = s.params === undefined || s.params === null ? {} : s.params;
    if (!isObj(p)) fail("params must be an object", path + ".params");
    only(p, Object.keys(def.params), path + ".params");
    var out = {};
    Object.keys(def.params).forEach(function (k) {
      var spec = def.params[k], v = p[k];
      if (spec === "uuid") out[k] = uuid(v, path + ".params." + k);
      else if (Array.isArray(spec)) out[k] = oneOf(v, spec, path + ".params." + k, spec[0]);
    });
    return { name: name, params: out };
  }

  function cleanBlock(b, i, source, path) {
    if (!isObj(b)) fail("a block must be an object", path);
    var type = oneOf(b.type, Object.keys(BLOCKS), path + ".type");
    var o = { type: type };
    if (b.view !== undefined) {
      if (!BLOCKS[type].view) fail(type + " takes no view", path + ".view");
      if (!source) fail("a view needs the widget's source", path + ".view");
      var v = SOURCES[source.name].views[b.view];
      if (typeof b.view !== "string" || !v) fail("no such view of " + source.name + " (views: " + Object.keys(SOURCES[source.name].views).join(", ") + ")", path + ".view");
      if (v.block !== type) fail(source.name + "." + b.view + " feeds a " + v.block + " block, not " + type, path + ".view");
      var allowedV = ["type", "view", "label", "style"];
      only(b, allowedV, path);
      o.view = b.view;
      if (b.label !== undefined) o.label = str(b.label, 40, path + ".label", true);
      if (type === "chart") o.style = oneOf(b.style, ["bar", "line"], path + ".style", "bar");
      return o;
    }
    switch (type) {
      case "text":
        only(b, ["type", "text", "tone"], path);
        o.text = str(b.text, LIMITS.TEXT, path + ".text");
        o.tone = oneOf(b.tone, TONES, path + ".tone", true);
        break;
      case "metric":
        only(b, ["type", "label", "value", "unit", "hint", "tone"], path);
        o.label = str(b.label, 40, path + ".label");
        o.value = typeof b.value === "number" ? num(b.value, path + ".value") : str(b.value, 24, path + ".value");
        o.unit = oneOf(b.unit, UNITS, path + ".unit", true);
        o.hint = str(b.hint, 80, path + ".hint", true);
        o.tone = oneOf(b.tone, TONES, path + ".tone", true);
        break;
      case "chart":
        only(b, ["type", "style", "unit", "series"], path);
        o.style = oneOf(b.style, ["bar", "line"], path + ".style", "bar");
        o.unit = oneOf(b.unit, UNITS, path + ".unit", true);
        o.series = arr(b.series, 1, LIMITS.SERIES, path + ".series").map(function (s, k) {
          var sp = path + ".series[" + k + "]";
          if (!isObj(s)) fail("a series must be an object", sp);
          only(s, ["label", "points"], sp);
          return {
            label: str(s.label, 40, sp + ".label"),
            points: arr(s.points, 1, LIMITS.POINTS, sp + ".points").map(function (pt, j) {
              var pp = sp + ".points[" + j + "]";
              if (!Array.isArray(pt) || pt.length !== 2) fail("a point is [x label, y number]", pp);
              return [str(String(pt[0] == null ? "" : pt[0]), 16, pp + "[0]"), num(pt[1], pp + "[1]")];
            }),
          };
        });
        break;
      case "table":
        only(b, ["type", "columns", "rows"], path);
        o.columns = arr(b.columns, 1, LIMITS.COLS, path + ".columns").map(function (c, k) {
          var cp = path + ".columns[" + k + "]";
          if (!isObj(c)) fail("a column must be an object", cp);
          only(c, ["key", "label", "align", "format"], cp);
          if (typeof c.key !== "string" || !KEY.test(c.key)) fail("key: a-z, 0-9, _ (up to 24)", cp + ".key");
          return { key: c.key, label: str(c.label, 32, cp + ".label"), align: oneOf(c.align, ["left", "right"], cp + ".align", "left"), format: oneOf(c.format, FORMATS, cp + ".format", "text") };
        });
        var keys = o.columns.map(function (c) { return c.key; });
        if (keys.some(function (k, j) { return keys.indexOf(k) !== j; })) fail("column keys must differ", path + ".columns");
        o.rows = arr(b.rows, 0, LIMITS.ROWS, path + ".rows").map(function (r, k) {
          var rp = path + ".rows[" + k + "]";
          if (!isObj(r)) fail("a row must be an object", rp);
          only(r, keys, rp);
          var row = {};
          keys.forEach(function (key) {
            var v = r[key];
            if (v === undefined || v === null) row[key] = "";
            else if (typeof v === "number") row[key] = num(v, rp + "." + key);
            else row[key] = str(v, LIMITS.CELL, rp + "." + key, true);
          });
          return row;
        });
        break;
      case "list":
        only(b, ["type", "items"], path);
        o.items = arr(b.items, 1, LIMITS.ITEMS, path + ".items").map(function (it, k) {
          var ip = path + ".items[" + k + "]";
          if (!isObj(it)) fail("an item must be an object", ip);
          only(it, ["text", "sub", "tone", "session"], ip);
          var x = { text: str(it.text, 160, ip + ".text"), sub: str(it.sub, 120, ip + ".sub", true), tone: oneOf(it.tone, TONES, ip + ".tone", true) };
          if (it.session !== undefined && it.session !== null && it.session !== "") x.session = uuid(it.session, ip + ".session");
          return x;
        });
        break;
      case "files":
        only(b, ["type", "files"], path);
        o.files = arr(b.files, 1, LIMITS.FILES, path + ".files").map(function (f, k) {
          var fp = path + ".files[" + k + "]";
          if (!isObj(f)) fail("a file must be an object", fp);
          only(f, ["path", "add", "del"], fp);
          return { path: str(f.path, 240, fp + ".path"), add: int(f.add === undefined ? 0 : f.add, 0, 1e7, fp + ".add"), del: int(f.del === undefined ? 0 : f.del, 0, 1e7, fp + ".del") };
        });
        break;
      case "story":
        only(b, ["type", "session"], path);
        o.session = uuid(b.session, path + ".session");
        break;
      case "compare": {
        only(b, ["type", "sessions"], path);
        var ss = arr(b.sessions, 2, 2, path + ".sessions").map(function (s, k) { return uuid(s, path + ".sessions[" + k + "]"); });
        if (ss[0] === ss[1]) fail("two different sessions", path + ".sessions");
        o.sessions = ss;
        break;
      }
      case "approval":
        only(b, ["type", "approval"], path);
        o.approval = int(b.approval, 1, 1e12, path + ".approval");
        break;
    }
    return o;
  }

  /** The widget, checked and made canonical; or why not (and where). */
  function validate(spec) {
    try {
      if (!isObj(spec)) fail("a widget is a JSON object", "widget");
      var size;
      try { size = JSON.stringify(spec).length; } catch (e) { fail("not plain JSON", "widget"); }
      if (size > LIMITS.MAX_BYTES) fail("larger than " + LIMITS.MAX_BYTES + " bytes: put less in it, or use a source", "widget");
      only(spec, ["v", "kind", "title", "note", "source", "size", "blocks"], "widget");
      if (spec.v !== VERSION) fail("v must be " + VERSION + " (this catalog's version)", "widget.v");
      var kind = oneOf(spec.kind, Object.keys(KINDS), "widget.kind");
      var out = { v: VERSION, kind: kind, title: str(spec.title, LIMITS.TITLE, "widget.title") };
      var note = str(spec.note, LIMITS.NOTE, "widget.note", true);
      if (note) out.note = note;
      var source = spec.source === undefined || spec.source === null ? null : cleanSource(spec.source, "widget.source");
      if (source) out.source = source;
      out.size = oneOf(spec.size, ["s", "m", "l"], "widget.size", "m");
      out.blocks = arr(spec.blocks, 1, LIMITS.MAX_BLOCKS, "widget.blocks").map(function (b, i) { return cleanBlock(b, i, source, "widget.blocks[" + i + "]"); });
      var first = out.blocks[0].type;
      if (KIND_BLOCKS[kind].indexOf(first) < 0) fail("a " + kind + " widget starts with a " + KIND_BLOCKS[kind].join(" or ") + " block", "widget.blocks[0].type");
      // story / compare / approval read their own source; one of each per widget is plenty.
      ["story", "compare", "approval"].forEach(function (t) {
        if (out.blocks.filter(function (b) { return b.type === t; }).length > 1) fail("one " + t + " block per widget", "widget.blocks");
      });
      return { ok: true, value: out, key: learnKey(out) };
    } catch (e) {
      if (e instanceof Bad) return { ok: false, why: e.path + ": " + e.why, path: e.path };
      throw e;
    }
  }

  /** What the board learns per person: the kind, and where its data comes from. */
  function learnKey(w) {
    if (!w) return "";
    var src = w.source && w.source.name;
    if (!src) {
      var b = w.blocks && w.blocks[0];
      src = b && (b.type === "story" || b.type === "compare") ? "story" : b && b.type === "approval" ? "approvals" : "payload";
    }
    return w.kind + ":" + src;
  }

  /** The catalog: everything JOYA AI may put in a widget, read at run time (its ui_widgets_list tool). */
  function catalog() {
    var src = {};
    Object.keys(SOURCES).forEach(function (k) {
      var s = SOURCES[k], views = {};
      Object.keys(s.views).forEach(function (v) { views[v] = s.views[v].block + ": " + s.views[v].what; });
      src[k] = { what: s.label, params: s.params, views: views };
    });
    var blocks = {};
    Object.keys(BLOCKS).forEach(function (k) { blocks[k] = { what: BLOCKS[k].what, fields: BLOCKS[k].fields, takes_view: !!BLOCKS[k].view }; });
    return {
      version: VERSION,
      call_with: "ui_widget, with {\"widget\": {...}} -- the widget as JSON",
      shape: "{ v: 1, kind, title (<= 80), note (optional, <= 200), source (optional: {name, params}), size (s|m|l, optional), blocks: [1-6 blocks] }",
      kinds: KINDS,
      kind_first_block: KIND_BLOCKS,
      blocks: blocks,
      sources: src,
      limits: LIMITS,
      rules: [
        "Only JSON from this catalog: no HTML, script, style or URL anywhere -- an unknown field or a URL is refused.",
        "Data comes from the payload (small: the limits above) or, better, from a source: a block {type, view} reads that view of the widget's source and the board keeps it live.",
        "story, compare and approval blocks name what they show (session ids, an approval id); their text is read from the real data, never from you.",
        "An approval widget only opens the existing decision card; approving stays the administrator's click, with the usual step-up.",
        "Send a widget only when it helps the answer you are giving, alongside your words (never instead of them), and only during a request the administrator made from the Command Center.",
        "The administrator pins, resizes or dismisses it; kinds they always dismiss stop being offered (the result says so: then answer in words).",
      ],
      examples: [
        { v: 1, kind: "chart", title: "Spend, last 14 days", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days" }, { type: "metric", view: "today" }] },
        { v: 1, kind: "story", title: "Planning engine", blocks: [{ type: "story", session: "bbbbbbbb-0000-4000-8000-000000000001" }] },
        { v: 1, kind: "table", title: "Disk use by folder", blocks: [{ type: "table", columns: [{ key: "dir", label: "Folder" }, { key: "gb", label: "GB", align: "right", format: "number" }], rows: [{ dir: "/var/lib/odoo", gb: 41.2 }, { dir: "/root/backups", gb: 27.9 }] }] },
      ],
    };
  }

  return { VERSION: VERSION, LIMITS: LIMITS, KINDS: KINDS, BLOCKS: BLOCKS, SOURCES: SOURCES, KIND_BLOCKS: KIND_BLOCKS, validate: validate, learnKey: learnKey, catalog: catalog };
});
