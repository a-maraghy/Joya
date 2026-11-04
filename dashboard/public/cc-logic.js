"use strict";
/*
 * The Command Center's pure logic, shared by the page and the tests.
 *
 * No DOM, no fetch: every function takes plain data and returns plain data, so
 * node can require this file (tools/test-cc-logic.cjs) and the page loads the
 * same text as window.JoyaLogic. What lives here:
 *
 *   - the JOYA AI core setting: the five concepts and the default (D); core E's
 *     head style and colours (presets, custom picks and their derived shades);
 *   - coreState / caption: what the core shows and what the one-line caption
 *     under it says, from what is really happening (the turn and its current
 *     step, a delegation and its target, the sentence being spoken, the
 *     microphone, anything waiting for you);
 *   - the decision card: which items need you, in what order, and which
 *     buttons each one gets -- every button names the existing API it calls;
 *   - the dock: the sheets behind the left icon bar, in order.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JoyaLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /* ------------------------------------------------------------ the core */

  // D (Mesh, joya-core-d.js) is the default since 2026-10-06.
  // E (Bot, joya-core-bot.js, 2026-10-19): a wireframe bot head whose face carries the state.
  // A, B and C were retired on 2026-10-25; a stored one reads as E (lib/db.js moved everyone on them to E).
  var CORES = { D: "Mesh", E: "Bot" };
  var CORE_DEFAULT = "D";
  var RETIRED_CORES = { A: "E", B: "E", C: "E" };
  /** A saved or requested core, as D or E; a retired one is E; anything else is the default. */
  function normCore(c) {
    c = String(c == null ? "" : c).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(RETIRED_CORES, c)) return RETIRED_CORES[c];
    return Object.prototype.hasOwnProperty.call(CORES, c) ? c : CORE_DEFAULT;
  }
  /** Whether a request names a core at all (the API refuses anything else). */
  function isCore(c) {
    return typeof c === "string" && Object.prototype.hasOwnProperty.call(CORES, c);
  }

  /* ------------------------------------------------------------ core E: the bot */

  /**
   * The bot's head style (users.joya_bot_head): one of the ten approved heads
   * (mockups/emo-core-states). Empty or unknown reads as the first, "cap".
   */
  var BOT_HEADS = {
    cap: "Cap & headphones", headphones: "Headphones", beanie: "Beanie", goggles: "Goggles", headset: "Headset & mic",
    ears: "Cat ears", halo: "Halo", mortar: "Graduation cap", antennas: "Twin antennas", bowtie: "Bow tie",
  };
  var BOT_HEAD_DEFAULT = "cap";
  function normBotHead(h) {
    h = String(h == null ? "" : h).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(BOT_HEADS, h) ? h : BOT_HEAD_DEFAULT;
  }
  function isBotHead(h) { return typeof h === "string" && Object.prototype.hasOwnProperty.call(BOT_HEADS, h); }

  /**
   * The bot's face style (users.joya_bot_face, 2026-10-22, mockups/bot-face-v3): how its eyes and mouth are drawn
   * (public/joya-core-bot.js FACE). Empty or unknown reads as "smooth".
   */
  var BOT_FACES = { smooth: "Smooth", dots: "Dot matrix", minimal: "Minimal" };
  var BOT_FACE_DEFAULT = "smooth";
  function normBotFace(f) {
    f = String(f == null ? "" : f).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(BOT_FACES, f) ? f : BOT_FACE_DEFAULT;
  }
  function isBotFace(f) { return typeof f === "string" && Object.prototype.hasOwnProperty.call(BOT_FACES, f); }

  /*
   * The bot's colours (users.joya_bot_colors, JSON {p: preset, c: {item: "#RRGGBB"}}): one colour per
   * state and one for the wireframe. A preset carries its own dark- and light-theme shades (Default is
   * the approved set) or one base colour per item; a custom colour is one pick per item. A base / custom
   * pick's shade for each theme is derived (botShade): lightened until it reaches 3:1 on the dark
   * background, darkened until 3:1 on the light one.
   */
  var BOT_ITEMS = ["ready", "listening", "thinking", "speaking", "needs", "error", "wire"];
  var BOT_STATE_ITEMS = BOT_ITEMS.slice(0, 6);
  var BOT_ITEM_LABEL = { ready: "Ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking", needs: "Needs you", error: "Error", wire: "Wireframe" };
  var BOT_BG = { dark: "#0D1117", light: "#F8FAFC" }; // the page backgrounds (style.css --bg)
  var BOT_PRESETS = {
    default: {
      name: "Default",
      dark: { ready: "#00E6A5", listening: "#38D6FF", thinking: "#966EFF", speaking: "#FF5AC8", needs: "#FFBE3C", error: "#FF5050", wire: "#E1E8F8" },
      light: { ready: "#00785A", listening: "#006EAA", thinking: "#6D2BC8", speaking: "#BE1E8C", needs: "#B46900", error: "#C81E1E", wire: "#262E40" },
      rim: ["#38D6FF", "#966EFF"], rimL: "#6D2BC8",
    },
    joya: {
      name: "Joya only",
      dark: { ready: "#00E6A5", listening: "#00E6A5", thinking: "#00E6A5", speaking: "#00E6A5", needs: "#00E6A5", error: "#00E6A5", wire: "#E1E8F8" },
      light: { ready: "#00785A", listening: "#00785A", thinking: "#00785A", speaking: "#00785A", needs: "#00785A", error: "#00785A", wire: "#262E40" },
      rim: ["#00E6A5", "#38D6FF"], rimL: "#00785A",
    },
    mono: {
      name: "Mono",
      dark: { ready: "#FFFFFF", listening: "#FFFFFF", thinking: "#FFFFFF", speaking: "#FFFFFF", needs: "#FFFFFF", error: "#FFFFFF", wire: "#EBF0FA" },
      light: { ready: "#0A0A0A", listening: "#0A0A0A", thinking: "#0A0A0A", speaking: "#0A0A0A", needs: "#0A0A0A", error: "#0A0A0A", wire: "#14161E" },
      rim: ["#C8D2E6", "#C8D2E6"], rimL: "#14161E", wireK: 1.45,
    },
    ocean: {
      name: "Ocean",
      base: { ready: "#2EE6C0", listening: "#3AA0FF", thinking: "#8B7CFF", speaking: "#E879F9", needs: "#FFB347", error: "#FF5A5F", wire: "#D6ECF5" },
      rim: ["#3AA0FF", "#2EE6C0"], rimL: "#0B5F8A",
    },
    sunset: {
      name: "Sunset",
      base: { ready: "#FF8FB1", listening: "#7DA6FF", thinking: "#B48CFF", speaking: "#FF6B3D", needs: "#FFC233", error: "#FF2E4D", wire: "#F5E6E8" },
      rim: ["#FF8C5A", "#C85AFF"], rimL: "#9A2C5E",
    },
  };
  var BOT_PRESET_DEFAULT = "default";
  var HEX = /^#[0-9a-fA-F]{6}$/;
  function hexRgb(h) { var n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbHex(c) { return "#" + c.map(function (v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? "0" + s : s; }).join("").toUpperCase(); }
  function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  /** WCAG relative luminance and contrast ratio (colours as "#RRGGBB" or [r, g, b]). */
  function luminance(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function contrast(a, b) {
    var x = luminance(typeof a === "string" ? hexRgb(a) : a), y = luminance(typeof b === "string" ? hexRgb(b) : b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function rgbHsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d > 1e-9) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslRgb(h, s, l) {
    function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  }
  /**
   * One picked colour's shade for a theme: on the dark background it is lightened (HSL lightness, 1 %
   * steps) until it reaches 3:1, on the light background darkened until 3:1; a colour that already
   * does is kept as it is. Returns "#RRGGBB".
   */
  function botShade(hex, theme) {
    var c = hexRgb(HEX.test(hex) ? hex : "#808080"), bg = hexRgb(theme === "light" ? BOT_BG.light : BOT_BG.dark);
    if (contrast(c, bg) >= 3) return rgbHex(c);
    var hsl = rgbHsl(c), dir = theme === "light" ? -1 : 1, out = c;
    for (var i = 1; i <= 100; i++) {
      var l = Math.max(0, Math.min(1, hsl[2] + dir * i * 0.01));
      out = hslRgb(hsl[0], hsl[1], l);
      if (contrast(rgbHex(out), bg) >= 3 || l <= 0 || l >= 1) break;
    }
    return rgbHex(out);
  }
  /** A preset's base colours (what the pickers start from): its own picks, or its dark-theme set. */
  function botPresetBase(p) { var P = BOT_PRESETS[p] || BOT_PRESETS[BOT_PRESET_DEFAULT]; return P.base || P.dark; }
  /** A stored / requested colour setting as { p, c } (c complete); anything malformed reads as the default. */
  function normBotColors(v) {
    if (typeof v === "string") { try { v = v ? JSON.parse(v) : null; } catch (e) { v = null; } }
    v = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    var p = v.p != null ? v.p : v.preset;
    p = p === "custom" || (typeof p === "string" && Object.prototype.hasOwnProperty.call(BOT_PRESETS, p)) ? p : BOT_PRESET_DEFAULT;
    var src = v.c || v.custom || {}, base = botPresetBase(p === "custom" ? BOT_PRESET_DEFAULT : p), c = {};
    BOT_ITEMS.forEach(function (k) { c[k] = typeof src[k] === "string" && HEX.test(src[k]) ? src[k].toUpperCase() : base[k]; });
    return { p: p, c: c };
  }
  /**
   * The API's check (POST /joya-ai/api/prefs/bot): { preset, custom? } -- the preset one of the presets
   * or "custom", every custom colour "#rrggbb" (hex only, known items only; custom needs all seven).
   * Returns { ok: true, value: {p, c} } or { ok: false, error }.
   */
  function checkBotColors(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The colours must be an object: {preset, custom}." };
    var p = v.preset != null ? v.preset : v.p;
    if (typeof p !== "string" || !(p === "custom" || Object.prototype.hasOwnProperty.call(BOT_PRESETS, p))) return { ok: false, error: "The colour preset must be one of " + Object.keys(BOT_PRESETS).join(", ") + " or custom." };
    var c = v.custom != null ? v.custom : v.c;
    if (c != null) {
      if (typeof c !== "object" || Array.isArray(c)) return { ok: false, error: "The custom colours must be an object." };
      var keys = Object.keys(c);
      for (var i = 0; i < keys.length; i++) {
        if (BOT_ITEMS.indexOf(keys[i]) < 0) return { ok: false, error: "Unknown colour: " + String(keys[i]).slice(0, 40) + "." };
        if (typeof c[keys[i]] !== "string" || !HEX.test(c[keys[i]])) return { ok: false, error: "Colours are #rrggbb hex (" + keys[i] + ")." };
      }
    }
    if (p === "custom" && !(c && BOT_ITEMS.every(function (k) { return typeof c[k] === "string"; }))) return { ok: false, error: "Custom colours need a colour for each of " + BOT_ITEMS.join(", ") + "." };
    return { ok: true, value: normBotColors({ p: p, c: c || {} }) };
  }
  /** The stored form (compact JSON; a preset alone keeps no colours), and a short line for the audit log. */
  function botColorsJson(v) { v = normBotColors(v); return JSON.stringify(v.p === "custom" ? v : { p: v.p }); }
  function botColorsLine(v) {
    v = normBotColors(v);
    if (v.p !== "custom") return BOT_PRESETS[v.p].name;
    return "Custom (" + BOT_ITEMS.map(function (k) { return k + " " + v.c[k]; }).join(", ") + ")";
  }
  /**
   * The colours to draw with in one theme, as [r, g, b] (0..255): each state, the wireframe (wireK: how
   * strong), and the soft glow behind the head (rim: two stops, dark theme; rimL: light theme).
   */
  function botPalette(v, light) {
    v = normBotColors(v);
    var th = light ? "light" : "dark", out = {}, P = v.p === "custom" ? null : BOT_PRESETS[v.p];
    BOT_ITEMS.forEach(function (k) { out[k] = hexRgb(P ? (P[th] ? P[th][k] : botShade(P.base[k], th)) : botShade(v.c[k], th)); });
    out.wireK = (P && P.wireK) || 1;
    var rim = P ? P.rim : [botShade(v.c.listening, "dark"), botShade(v.c.thinking, "dark")];
    out.rim = [hexRgb(rim[0]), hexRgb(rim[1])];
    out.rimL = hexRgb(P ? P.rimL : botShade(v.c.thinking, "light"));
    return out;
  }
  /** CIE76 colour difference (sRGB -> Lab, D65). */
  function lab(c) {
    var r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
    var x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116; }
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }
  function deltaE(a, b) { var p = lab(a), q = lab(b); return Math.sqrt(Math.pow(p[0] - q[0], 2) + Math.pow(p[1] - q[1], 2) + Math.pow(p[2] - q[2], 2)); }
  var BOT_CLOSE_DE = 20;
  /**
   * State colours too close to tell apart, in either theme: [["ready", "listening"], ...]. The face
   * still differs, so this is a warning in Settings, never a refusal (Joya only / Mono are one colour on purpose).
   */
  function botClosePairs(v) {
    var out = [], seen = {};
    [false, true].forEach(function (light) {
      var P = botPalette(v, light);
      for (var i = 0; i < BOT_STATE_ITEMS.length; i++) for (var j = i + 1; j < BOT_STATE_ITEMS.length; j++) {
        var a = BOT_STATE_ITEMS[i], b = BOT_STATE_ITEMS[j];
        if (!seen[a + "|" + b] && deltaE(P[a], P[b]) < BOT_CLOSE_DE) { seen[a + "|" + b] = 1; out.push([a, b]); }
      }
    });
    return out;
  }
  /** The core's states (and offline) as the bot's colour item and face. */
  var BOT_STATE_FACE = {
    idle: { state: "ready", face: "base" }, listening: { state: "listening", face: "listen" }, thinking: { state: "thinking", face: "focus" },
    delegating: { state: "thinking", face: "base" }, speaking: { state: "speaking", face: "speak" }, needs: { state: "needs", face: "pupils" },
    error: { state: "error", face: "err" }, offline: { state: "error", face: "err" },
  };
  function botFace(st) { return BOT_STATE_FACE[st] || BOT_STATE_FACE.idle; }
  /**
   * What a session's head shows (with core E the sessions are small bots): the core's colour + face
   * language. Waiting on you -> needs you; a delegation landing -> listening; a reply going back ->
   * speaking; just finished -> ready, grinning; working -> thinking; idle -> ready.
   */
  function botSessState(k) {
    k = k || {};
    if (k.st === "waiting") return { state: "needs", face: "pupils" };
    if ((k.catchK || 0) > 0.25) return { state: "listening", face: "listen" };
    if ((k.glow || 0) > 0.35) return { state: "speaking", face: "speak" };
    if ((k.bloom || 0) > 0.25) return { state: "ready", face: "grin" };
    if (k.st === "working") return { state: "thinking", face: "focus" };
    return { state: "ready", face: "base" };
  }

  /*
   * A team of bots (2026-10-20): with core E each session's head wears an accessory for its role instead of
   * copying the core's. The rules, in order (the first that matches wins), read the session's name and its
   * working directory (cwd); a session JOYA AI hired matches before anything else:
   *
   *   role       head        matches
   *   hired      cap         hired by JOYA AI (hired: true, or a hire record)        cap & headphones
   *   planning   mortar      plan / planning / planner / mandate / allocation       graduation cap
   *   erp        headset     odoo / erp / giza / gizaseeds                          headset & mic
   *   builder    antennas    joya os / joya ai / dashboard / desktop / builder / claude agents / Joya    twin antennas
   *   other      headphones  anything else                                          headphones
   *
   * The viewer can pin a head for a session (users.joya_bot_team: JSON {session name (normName): head}); the
   * pin follows the session's name, so it survives a restart. The core keeps the viewer's own head.
   */
  var BOT_ROLE_RULES = [
    { role: "hired", head: "cap", label: "Hired", hired: true },
    { role: "planning", head: "mortar", label: "Planning", re: /\bplan(?:s|ning|ner|ners)?\b|\bmandate\b|\ballocation\b/i },
    { role: "erp", head: "headset", label: "Odoo / ERP", re: /\bodoo\b|\berp\b|\bgiza(?:seeds)?\b/i },
    { role: "builder", head: "antennas", label: "Joya / builder", re: /\bjoya\b|\bdashboard\b|\bdesktop\b|\bbuilder\b|\bclaude ?agents\b/i },
  ];
  var BOT_ROLE_DEFAULT = { role: "other", head: "headphones", label: "Other" };
  /** A session's role and the head it wears by default: botRole({name, cwd, hired, hire}) -> {role, head, label}. */
  function botRole(s) {
    s = s || {};
    var text = (String(s.name || "") + " " + String(s.cwd || "")).replace(/[_\/.-]+/g, " ");
    for (var i = 0; i < BOT_ROLE_RULES.length; i++) {
      var r = BOT_ROLE_RULES[i];
      if (r.hired ? s.hired === true || !!s.hire : r.re.test(text) || r.re.test(String(s.cwd || ""))) return { role: r.role, head: r.head, label: r.label };
    }
    return { role: BOT_ROLE_DEFAULT.role, head: BOT_ROLE_DEFAULT.head, label: BOT_ROLE_DEFAULT.label };
  }
  var BOT_TEAM_MAX = 64;
  /** The key a session's pin is stored under: its name, normalised (normName). */
  function botTeamKey(name) { return normName(name).slice(0, 80); }
  /** The stored pins (users.joya_bot_team), cleaned: {key: head}; anything that is not JSON, or not a head, is dropped. */
  function normBotTeam(v) {
    if (typeof v === "string") { try { v = v ? JSON.parse(v) : {}; } catch (e) { v = {}; } }
    var out = {}, n = 0;
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    Object.keys(v).forEach(function (k) {
      var key = botTeamKey(k), h = v[k];
      if (!key || n >= BOT_TEAM_MAX || !isBotHead(h) || Object.prototype.hasOwnProperty.call(out, key)) return;
      out[key] = h; n++;
    });
    return out;
  }
  function botTeamJson(v) { return JSON.stringify(normBotTeam(v)); }
  /**
   * The API's check (POST /joya-ai/api/prefs/bot-team): { name, head } -- name a session's name (1-120 chars),
   * head one of the ten or "" / null for "back to its role's". -> { ok, key, head } or { ok: false, error }.
   */
  function checkBotTeamEdit(b) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "Send a session name and a head." };
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) return { ok: false, error: "The session name must be 1 to 120 characters." };
    var key = botTeamKey(b.name);
    if (!key) return { ok: false, error: "The session name must be 1 to 120 characters." };
    if (b.head === "" || b.head === null || b.head === "auto") return { ok: true, key: key, head: null };
    if (!isBotHead(b.head)) return { ok: false, error: "The head must be one of " + Object.keys(BOT_HEADS).join(", ") + ", or empty for its role's." };
    return { ok: true, key: key, head: b.head };
  }
  /** The pins with one edit applied (head null: the pin removed); refuses a 65th pin. */
  function applyBotTeamEdit(team, key, head) {
    var t = normBotTeam(team);
    if (head == null) { delete t[key]; return { ok: true, team: t }; }
    if (!Object.prototype.hasOwnProperty.call(t, key) && Object.keys(t).length >= BOT_TEAM_MAX) return { ok: false, error: "At most " + BOT_TEAM_MAX + " sessions can have a head of their own." };
    t[key] = head;
    return { ok: true, team: t };
  }
  /** The head a session wears: its pin, else its role's. -> {head, role, label, pinned} */
  function botHeadFor(s, team) {
    var r = botRole(s), t = team && typeof team === "object" ? team : normBotTeam(team), key = botTeamKey(s && s.name);
    var pin = key && Object.prototype.hasOwnProperty.call(t, key) && isBotHead(t[key]) ? t[key] : null;
    return { head: pin || r.head, role: r.role, label: r.label, pinned: !!pin, auto: r.head };
  }
  /** A turn that ran long finished: the core grins (cc-map). Thinking / delegating (then maybe speaking) for 20 s or more, then idle. */
  var BOT_LONG_TURN_MS = 20000;
  function botTurnDone(prev, next, busyMs) {
    return next === "idle" && (prev === "thinking" || prev === "delegating" || prev === "speaking") && (busyMs || 0) >= BOT_LONG_TURN_MS;
  }

  /* The sessions view round the core: the family of spheres (the default) or the classic orbit of dots. */
  var SESS_VIEWS = { spheres: "Spheres", orbit: "Classic orbit" };
  var SESS_VIEW_DEFAULT = "spheres";
  function normSessView(v) {
    v = String(v == null ? "" : v).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SESS_VIEWS, v) ? v : SESS_VIEW_DEFAULT;
  }
  function isSessView(v) { return typeof v === "string" && Object.prototype.hasOwnProperty.call(SESS_VIEWS, v); }

  /**
   * Who is speaking, on the state pill (the relay's {type: "voiceprint", kind, gated, name, talkOnly}):
   * { label, tone: "ok" | "bad" | "mid", icon: "you" | "no" | "q" } -- never a score.
   *   known  a stored voiceprint, by name ("Recognised: Omar"; "Omar — talk only" when
   *          that person may not give commands and was answered in conversation only)
   *   other  an unknown voice; echo: JOYA AI's own voice coming back
   *   unsure not sure who's speaking (gate: not answered; nothing is ever spoken); short: too little speech (let through)
   * gated: "Only respond to stored voices" is on (what it did) or off (what it would have done).
   */
  var VP_SHOW_MS = 2600; // shown this long at most...
  var VP_MIN_MS = 1500; // ...and at least this long, even if the state moves on (an ignored turn goes straight back to listening)
  function vpBadge(kind, gated, name, talkOnly) {
    var n = oneLine(name || "", 40);
    if (kind === "known" || kind === "you") {
      if (!n) return { label: "Recognised", tone: "ok", icon: "you" };
      return talkOnly ? { label: n + " — talk only", tone: "mid", icon: "you" } : { label: "Recognised: " + n, tone: "ok", icon: "you" };
    }
    // gate on: said so as an invitation to try again (2026-10-21: the turn was dropped silently, "it did not understand")
    if (kind === "other") return gated ? { label: "Didn't recognise your voice, try again", tone: "bad", icon: "no" } : { label: "Unknown voice — would be ignored", tone: "bad", icon: "no" };
    if (kind === "echo") return { label: "JOYA AI's own voice — " + (gated ? "ignored" : "would be ignored"), tone: "bad", icon: "no" };
    if (kind === "unsure") return { label: "Not sure who's speaking" + (gated ? " — not answered" : ""), tone: "mid", icon: "q" };
    if (kind === "short") return { label: "Not sure who's speaking", tone: "mid", icon: "q" };
    return null;
  }

  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var LABEL = { idle: "Ready", listening: "Listening", thinking: "Thinking", delegating: "Delegating", speaking: "Speaking", needs: "Needs you" };

  function lcFirst(s) {
    s = String(s || "");
    return s.charAt(0).toLowerCase() + s.slice(1);
  }
  function oneLine(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    n = n || 180;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function endStop(s) {
    s = String(s || "").trim();
    return !s || /[.!?…:]$/.test(s) ? s : s + ".";
  }

  /**
   * The core's state from a snapshot of the page:
   *   { online, listening, speaking, voiceLive, delegatingTo, busy, pending }
   * Order: the microphone and the voice first (they are you, now), then
   * anything waiting for you, then a delegation just sent, then a running turn.
   */
  function coreState(s) {
    s = s || {};
    if (!s.online) return "idle";
    if (s.listening && !s.speaking) return "listening";
    if (s.speaking) return "speaking";
    if (s.pending > 0) return "needs";
    if (s.delegatingTo) return "delegating";
    if (s.busy || s.voiceLive) return "thinking";
    return "idle";
  }

  /**
   * The caption under the core: { state, label, text, interim, words }.
   *   words   true: the text is a sentence being spoken, revealed word by word
   *   interim true: what the microphone is hearing, not yet sent
   * Snapshot fields beyond coreState's:
   *   voiceText   the voice bar's line (what was heard, "Listening…", "Transcribing…")
   *   spoken      the sentence playing now
   *   stepText    the running turn's current step, in words
   *   streamText  the reply as it streams (its latest sentence is shown)
   *   delegation  the text or summary of the delegation just sent
   *   needTitle   the first thing waiting for you
   *   queued      turns waiting behind the running one
   *   lastReply   the gist of JOYA AI's last answer
   *   offlineMsg  why the supervisor is unreachable
   *   micNotReady hold-to-talk held but no audio flowing: why ("waiting for the microphone")
   *   pttWarm     hold-to-talk call warm between presses: the hint ("Hold Ctrl+Space to talk")
   */
  function caption(s) {
    s = s || {};
    var st = coreState(s);
    var out = { state: st, label: LABEL[st], text: "", interim: false, words: false };
    if (!s.online) {
      out.label = "Offline";
      out.text = oneLine(s.offlineMsg || "JOYA AI is not reachable right now.");
      return out;
    }
    // Hold-to-talk with the key down but no audio flowing: never a silent "Listening".
    if (s.micNotReady) {
      out.state = "needs";
      out.label = "Mic not ready";
      out.text = oneLine(s.micNotReady);
      return out;
    }
    if (st === "listening") {
      out.interim = true;
      out.text = oneLine(s.voiceText || "Listening…");
      return out;
    }
    if (st === "speaking") {
      out.words = true;
      out.text = oneLine(s.spoken || "…", 260);
      return out;
    }
    if (st === "needs") {
      var more = s.pending > 1 ? " (" + (s.pending - 1) + " more)" : "";
      out.text = s.needTitle ? "Waiting for you: " + endStop(lcFirst(oneLine(s.needTitle, 140))).replace(/\.$/, "") + more + "." : "Waiting for your decision.";
      return out;
    }
    if (st === "delegating") {
      out.label = "Delegating → " + oneLine(s.delegatingTo, 40);
      out.text = s.delegation ? oneLine(s.delegation, 200) : "Handing it to " + oneLine(s.delegatingTo, 60) + "…";
      return out;
    }
    if (st === "thinking") {
      if (s.voiceLive && !s.busy) {
        out.label = "Heard";
        out.text = oneLine(s.voiceText || "Transcribing…");
        out.interim = true;
        return out;
      }
      if (s.waitingOn) out.label = "Waiting on " + oneLine(s.waitingOn, 40);
      var line = lastSentence(s.streamText);
      out.text = line ? oneLine(line, 220) : s.stepText ? endStop(oneLine(s.stepText, 200)).replace(/\.$/, "…") : "Thinking it through…";
      if (s.queued > 0) out.label += " · " + s.queued + " queued";
      return out;
    }
    if (s.pausedAtCap) {
      // Its daily token cap (Settings > Usage & budget) holds every new turn until Resume.
      out.label = "Paused";
      out.text = "Paused at its daily cap — Resume from Decisions.";
      return out;
    }
    if (s.pttWarm) {
      // Hold-to-talk, the call warm between presses: not "Ready" (idle) and not "Listening".
      out.label = "Ready to talk";
      out.text = oneLine(s.pttWarm);
      return out;
    }
    out.text = s.lastReply ? oneLine(s.lastReply, 220) : "Ready when you are.";
    return out;
  }

  /*
   * The last reply rests after a quiet spell: with nothing happening for
   * CAPTION_REST_MS the caption's reply line fades and only "See last reply"
   * stays. Never while JOYA AI thinks, speaks, listens, delegates or waits on
   * you (any state but idle), while you type, while a voice call is on, while the
   * full reply is open, or when there is no reply to rest. `quietSince` is the
   * last activity (the page bumps it on each of those and on a new caption).
   */
  var CAPTION_REST_MS = 15000;
  function captionRests(o) {
    o = o || {};
    if (o.state !== "idle" || !o.hasReply || o.typing || o.voice || o.replyOpen || !o.online) return false;
    return (o.now || 0) - (o.quietSince || 0) >= CAPTION_REST_MS;
  }
  /**
   * The composer rests translucent when nothing is going on: online, JOYA AI
   * idle, no text in it, no voice turn or live call. Hover and focus lift it in
   * CSS; anything else here lifts it too.
   */
  function composerCalm(o) {
    o = o || {};
    return !!o.online && o.state === "idle" && !o.text && !o.voice && !o.live;
  }
  /** When to look again (ms from now), or null when nothing is counting down. */
  function captionRestIn(o) {
    o = o || {};
    if (o.state !== "idle" || !o.hasReply || o.typing || o.voice || o.replyOpen || !o.online) return null;
    return Math.max(0, CAPTION_REST_MS - ((o.now || 0) - (o.quietSince || 0)));
  }

  /** The last whole sentence of a streaming reply (or its tail, if none is whole yet). */
  function lastSentence(text) {
    var t = String(text || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    var parts = t.match(/[^.!?]+[.!?]+(?=\s|$)/g);
    if (parts && parts.length) return parts[parts.length - 1].trim();
    return t.length > 160 ? "…" + t.slice(-159) : t;
  }

  /** The gist of a reply for the idle caption: its first sentence, as plain text. */
  function gist(text) {
    var t = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[#>*+-]+\s*/gm, "").replace(/[*_~|]/g, "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    var m = /^.{12,}?[.!?](?=\s|$)/.exec(t);
    return oneLine(m ? m[0] : t, 200);
  }

  /* ------------------------------------------------- the decision card */

  var DEC_NEED = { investigating: 1, proposed: 1, open: 1 };

  /** Everything waiting for you, oldest approval first, then the freshest findings. */
  function needQueue(approvals, decisions) {
    var aps = (approvals || []).filter(function (a) { return a && a.status === "pending"; })
      .sort(function (a, b) { return a.id - b.id; })
      .map(function (a) { return { type: "approval", id: a.id, key: "a" + a.id, item: a }; });
    var ds = (decisions || []).filter(function (d) { return d && DEC_NEED[d.status]; })
      .sort(function (a, b) { return String(b.last_seen || b.updated_at || "").localeCompare(String(a.last_seen || a.updated_at || "")); })
      .map(function (d) { return { type: "decision", id: d.id, key: "d" + d.id, item: d }; });
    return aps.concat(ds);
  }

  /* ---- token counts, as the Usage sheet shows them (cc-panels.js tokens(), TOK_KEYS) ---- */
  var TOK_KEYS = [["input", "Input"], ["output", "Output"], ["cache_read", "Cache read"], ["cache_write", "Cache write"]];
  /** Tokens as people read them: 812, 44k, 3.1M. */
  function tokens(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  function fullNum(n) { return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  /** "1.2M tok" (+ suffix) from {input, output, cache_read, cache_write, total}; "" when there is nothing. */
  function tokLine(t, suffix) {
    if (!t || t.total == null) return "";
    return tokens(t.total) + " tok" + (suffix ? " " + suffix : "");
  }
  /** The tooltip: the split, in full numbers. */
  function tokTip(t, note) {
    if (!t) return "";
    return TOK_KEYS.map(function (k) { return k[1] + " " + fullNum(t[k[0]]); }).join(" · ") + " · Total " + fullNum(t.total) + " (" + (note || "counted on this box from the transcripts") + ")";
  }

  /** Who asks: JOYA AI, or a session it hired (M-6: origin "session:<slug>"). */
  function approvalFrom(a) {
    return a && /^session:/.test(String(a.origin || "")) ? String(a.origin_name || a.origin.slice(8)) : "JOYA AI";
  }
  /** A card that must never grow an always-allow rule: a hired session's question, or a retire. */
  function approvalNoRule(a) {
    return !!a && (a.tool === "SessionRetire" || /^session:/.test(String(a.origin || "")));
  }
  function approvalWhat(a) {
    var inp = a.input || {};
    if (a.tool === "SessionRetire") return { title: "Retire the session " + String(inp.session || inp.name || "?"), cmd: "Ends it gracefully; its transcript is kept" };
    if (a.tool === "SendMessage") return { title: "Send a message to " + String(inp.to || "a session").replace(/\s*\[[0-9a-f]+\]$/, ""), cmd: String(inp.message || a.summary || "") };
    if (typeof inp.command === "string") return { title: a.label ? String(a.label) : "Run a command", cmd: inp.command };
    return { title: "Use " + (a.tool || "a tool"), cmd: String(a.summary || a.tool || "") };
  }

  /**
   * The card for one queue item: { kind, icon, title, meta, why, actions }.
   * Each action is { act, label, primary?, path?, body?, local? }: `path` is the
   * existing /joya-ai/api/ route it posts to; `local` ones never leave the page
   * (Later hides the card, Always allow opens its rule dialog).
   */
  function card(q) {
    var c = cardOf(q);
    if (!c) return c;
    // Approving (and Resume) asks for Windows Hello, or the authenticator code (dashboard lib/stepup.js).
    c.actions.forEach(function (x) { if (x.act === "approve" || x.act === "resume" || x.act === "always") x.hello = true; });
    c.hello = c.actions.some(function (x) { return x.hello; });
    return c;
  }
  // Password-only sign-in (dashboard lib/signin.js, <body data-signin="password">): approving asks for the password.
  // Read when shown, not at load: this file may load before <body> exists.
  function helloHint() {
    var pw = typeof document !== "undefined" && !!document.body && document.body.getAttribute("data-signin") === "password";
    return pw
      ? "Approving asks for your password."
      : "Approving asks for Windows Hello. No passkey on this device, or Hello fails? Your authenticator code works too.";
  }
  function cardOf(q) {
    if (!q) return null;
    var id = encodeURIComponent(String(q.id));
    var later = { act: "later", label: "Later", local: true };
    if (q.type === "approval") {
      var a = q.item, w = approvalWhat(a), from = approvalFrom(a);
      if (a.tool === "SessionRetire") {
        // JOYA AI asks to retire a session it hired: the Keep / Retire consent (M-6).
        return {
          kind: "Retire", icon: "stop", title: w.title, meta: "Asked by JOYA AI · " + w.cmd,
          why: oneLine(a.reason || "Nothing ends unless you choose Retire.", 280),
          expires: a.expires_at || null, created: a.created_at || null,
          actions: [
            { act: "approve", label: "Retire", primary: true, path: "approvals/" + id + "/approve", body: {} },
            { act: "deny", label: "Keep", path: "approvals/" + id + "/deny", body: {} },
            later,
          ],
        };
      }
      var acts = [
        { act: "approve", label: "Approve", primary: true, path: "approvals/" + id + "/approve", body: {} },
        { act: "deny", label: "Deny", path: "approvals/" + id + "/deny", body: {} },
      ];
      if (!approvalNoRule(a)) acts.push({ act: "always", label: "Always allow…", local: true, link: true });
      acts.push(later);
      return {
        kind: "Approval", icon: "shield", title: w.title,
        meta: (from !== "JOYA AI" ? "From " + from + " (hired) · " : "") + oneLine(w.cmd, 160) + (a.mission_ref ? " · " + a.mission_ref + (a.step_n ? " step " + a.step_n : "") : ""),
        why: oneLine(a.reason || (a.category ? String(a.category).replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : "A step the gate treats as destructive. Nothing runs until you choose."), 280),
        expires: a.expires_at || null, created: a.created_at || null,
        actions: acts,
      };
    }
    var d = q.item;
    var retire = d.kind === "retire";
    var meta = [d.kind === "watcher" ? "watcher" + (d.watcher ? " · " + String(d.watcher).replace(/_/g, " ") : "") : d.kind || "decision"];
    if (d.subject) meta.push(oneLine(d.subject, 50));
    if (d.count > 1) meta.push("×" + d.count);
    if (d.fix_command) meta.push("$ " + oneLine(d.fix_command, 80));
    var why = d.proposal || d.detail || (d.status === "investigating" ? "JOYA AI is investigating…" : "");
    var out = { kind: retire ? "Retire" : d.kind === "watcher" ? "Watcher" : "Decision", icon: retire ? "stop" : "alert", title: oneLine(d.title || "A decision", 140), meta: meta.join(" · "), why: oneLine(why, 280), actions: [] };
    if (d.kind === "cap") {
      // A session at its daily token cap: Resume for today (the supervisor's budget-resume), or leave it
      // paused -- as the Decisions sheet offers (cc-panels.js). Never "Investigate": JOYA AI may be the one paused.
      out.kind = "Daily token cap";
      out.icon = "gauge";
      var canResume = (d.actions || []).indexOf("resume") >= 0;
      out.actions = (canResume ? [{ act: "resume", label: "Resume for today", primary: true, path: "decisions/" + id + "/resume", body: {} }] : [])
        .concat([{ act: "dismiss", label: canResume ? "Leave paused" : "Dismiss", path: "decisions/" + id + "/dismiss", body: {} }, later]);
    } else if (retire && (d.status === "proposed" || d.status === "open")) {
      out.actions = [
        { act: "approve", label: "Retire", primary: true, path: "decisions/" + id + "/approve", body: {} },
        { act: "dismiss", label: "Keep", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else if (d.status === "proposed") {
      out.actions = [
        { act: "approve", label: "Apply fix", primary: true, path: "decisions/" + id + "/approve", body: {} },
        { act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else if (d.status === "open") {
      out.actions = [
        { act: "investigate", label: "Investigate", primary: true, path: "decisions/" + id + "/ask", body: { text: "Investigate this and propose a fix." } },
        { act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else {
      out.actions = [{ act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} }, later];
    }
    return out;
  }

  /** What the card says once a choice went through. */
  function doneText(act) {
    return { approve: "Approved", deny: "Denied", dismiss: "Dismissed", investigate: "Asked JOYA AI to investigate", resume: "Resumed for today" }[act] || "Done";
  }

  /* ------------------------------------------------------------ the dock */

  /** The sheets behind the left icon bar (and the phone's Everything grid), in order. */
  var SHEETS = [
    { key: "conv", icon: "message", label: "Conversation" },
    { key: "sessions", icon: "orbit", label: "Sessions" },
    { key: "missions", icon: "flag", label: "Missions" },
    { key: "dec", icon: "inbox", label: "Decisions" },
    "-",
    { key: "tl", icon: "clock", label: "Timeline" },
    { key: "rules", icon: "shield", label: "Rules & alerts" },
    "-",
    { key: "cost", icon: "gauge", label: "Usage" },
    { key: "machine", icon: "server", label: "Machine" },
  ];
  function sheetKeys() {
    return SHEETS.filter(function (s) { return s !== "-"; }).map(function (s) { return s.key; });
  }

  /* ------------------------------------------------ who a delegation went to (the dot stream's target) */
  /** A session name as the supervisor compares them (joya-ai/lib/names.js norm): no [ref], lower case, spaces/dashes/underscores folded. */
  function normName(name) {
    return String(name == null ? "" : name).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  }
  /**
   * Names a session was known by: every session_id -> name pair seen (sessions events, delegation rows),
   * so an old name ("JOYA Agent OS") still finds the session it belonged to.
   */
  function makeAliases() {
    var byName = {}; // normalised name -> { session_id: true }
    function add(name, sid) {
      var n = normName(name);
      if (!n || !sid) return;
      (byName[n] = byName[n] || {})[sid] = true;
    }
    return {
      learnSessions: function (list) { (list || []).forEach(function (s) { if (s && !s.self) add(s.name, s.session_id); }); },
      learnDelegation: function (d) { if (d) add(d.target_name || d.target, d.target_session); },
      /** The one session id this name was seen with, or null (unknown, or seen with several). */
      idFor: function (name) { var ids = Object.keys(byName[normName(name)] || {}); return ids.length === 1 ? ids[0] : null; },
    };
  }
  function only(list) { return list.length === 1 ? list[0] : null; }
  /**
   * The live session a delegation went to, by stable id first:
   *   target_session (= session_id), then target_pid, then a UNIQUE normalised name, then the alias table.
   * Returns { session, why }: why is "ambiguous" (namesakes), "gone" (known id, not live) or "unknown".
   */
  function resolveTarget(d, sessions, aliases) {
    var live = (sessions || []).filter(function (s) { return s && !s.self; });
    if (!d) return { session: null, why: "unknown" };
    if (d.target_session) {
      var a = only(live.filter(function (s) { return s.session_id === d.target_session; }));
      if (a) return { session: a, why: "session" };
    }
    if (d.target_pid) {
      var b = only(live.filter(function (s) { return s.pid === d.target_pid; }));
      if (b) return { session: b, why: "pid" };
    }
    var nm = normName(d.target_name || d.target);
    if (nm) {
      var byName = live.filter(function (s) { return normName(s.name) === nm; });
      if (byName.length === 1) return { session: byName[0], why: "name" };
      if (byName.length > 1) return { session: null, why: "ambiguous" };
      var sid = aliases && aliases.idFor(nm);
      if (sid) {
        var c = only(live.filter(function (s) { return s.session_id === sid; }));
        if (c) return { session: c, why: "alias" };
      }
    }
    return { session: null, why: d.target_session || d.target_pid ? "gone" : "unknown" };
  }
  /** The live session an inbound message came from: from_pid first, then a unique normalised name. */
  function resolveFrom(row, sessions) {
    var live = (sessions || []).filter(function (s) { return s && !s.self; });
    if (!row) return null;
    if (row.from_pid) { var a = only(live.filter(function (s) { return s.pid === row.from_pid; })); if (a) return a; }
    var nm = normName(row.from_name);
    return nm ? only(live.filter(function (s) { return normName(s.name) === nm; })) : null;
  }
  /** What the ghost marker says for a target with no sphere. */
  function ghostWhere(d, why) {
    var k = d && d.target_kind;
    if (k === "remote") return "Remote";
    if (k === "subagent" || /^a?[0-9a-f]{12,20}$/.test(String((d && (d.target_name || d.target)) || ""))) return "sub-agent";
    if (why === "ambiguous") return "more than one session has this name";
    return "offline";
  }

  /* ------------------------------------------------------------ attachments
     Files attached to a message (lib/uploads.js keeps them; the server adds one line per file to the
     turn's text). The same allow-list and limits as the server, so the page can say no before uploading. */
  var ATTACH_MAX_BYTES = 20 * 1024 * 1024, ATTACH_MAX_FILES = 10;
  var ATTACH_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "tsv", "md", "json", "log", "xml", "yaml", "yml", "zip"];
  var ATTACH_ACCEPT = ATTACH_EXT.map(function (e) { return "." + e; }).join(",");
  // A pasted image comes as "image.png" or with no name: its type names the extension.
  var TYPE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" };
  function attachExt(name) { var m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }
  function attachSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (Math.round((n / (1024 * 1024)) * 10) / 10).toFixed(1) + " MB";
  }
  /** Why a file can't be attached, in words, or "" if it can. o: { name, size, have (files already attached) } */
  function attachRefusal(o) {
    o = o || {};
    var ext = attachExt(o.name);
    if (!ext || ATTACH_EXT.indexOf(ext) < 0) return (ext ? "." + ext + " files" : "Files without an extension") + " can't be attached";
    if (!o.size) return "it is empty";
    if (o.size > ATTACH_MAX_BYTES) return "it is " + attachSize(o.size) + "; the limit is 20 MB";
    if ((o.have || 0) >= ATTACH_MAX_FILES) return "a message can carry at most " + ATTACH_MAX_FILES + " files";
    return "";
  }
  /** A name for a file the clipboard gave without a useful one: "Pasted image 2026-10-25 21.48.png". */
  function pastedName(name, type, now) {
    var ext = attachExt(name);
    if (ext && !/^image\.(png|jpe?g|gif|webp)$/i.test(String(name))) return String(name);
    var e = ext || TYPE_EXT[type] || "";
    var d = new Date(now || Date.now());
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    var stamp = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes()) + "." + p(d.getSeconds());
    return (/^image\//.test(type || "") ? "Pasted image " : "Pasted file ") + stamp + (e ? "." + e : "");
  }
  var ATTACHED_RE = /^\[Attached file: (\/[^|\]\n]+) \| ([^|\]\n]+) \| ([A-Za-z0-9.+\/-]+) \| ([0-9.]+ (?:B|KB|MB))\]$/;
  /**
   * A turn's text and its files: the "[Attached file: …]" lines at its end, read back.
   * Returns { text, files: [{ path, name, type, size, image, url }] }; url is the page's route to
   * the file (its last three path parts), or "" for a path that is not an upload.
   */
  function splitAttached(text) {
    var lines = String(text == null ? "" : text).split("\n"), files = [];
    while (lines.length) {
      var m = ATTACHED_RE.exec(lines[lines.length - 1]);
      if (!m) break;
      lines.pop();
      var tail = /\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/[a-f0-9]{12}\.[a-z0-9]{1,5})$/.exec(m[1]);
      files.unshift({ path: m[1], name: m[2], type: m[3], size: m[4], image: /^image\/(png|jpeg|gif|webp)$/.test(m[3]), url: tail ? "/joya-ai/api/uploads/" + tail[1] : "" });
    }
    var rest = lines.join("\n").replace(/\s+$/, "");
    if (files.length && rest === "(files attached)") rest = "";
    return { text: files.length ? rest : String(text == null ? "" : text), files: files };
  }

  return {
    CORES: CORES, CORE_DEFAULT: CORE_DEFAULT, normCore: normCore, isCore: isCore,
    BOT_HEADS: BOT_HEADS, BOT_HEAD_DEFAULT: BOT_HEAD_DEFAULT, normBotHead: normBotHead, isBotHead: isBotHead,
    BOT_FACES: BOT_FACES, BOT_FACE_DEFAULT: BOT_FACE_DEFAULT, normBotFace: normBotFace, isBotFace: isBotFace,
    BOT_ITEMS: BOT_ITEMS, BOT_STATE_ITEMS: BOT_STATE_ITEMS, BOT_ITEM_LABEL: BOT_ITEM_LABEL, BOT_BG: BOT_BG, BOT_PRESETS: BOT_PRESETS, BOT_PRESET_DEFAULT: BOT_PRESET_DEFAULT,
    botPresetBase: botPresetBase, normBotColors: normBotColors, checkBotColors: checkBotColors, botColorsJson: botColorsJson, botColorsLine: botColorsLine,
    botShade: botShade, botPalette: botPalette, botClosePairs: botClosePairs, contrast: contrast, deltaE: deltaE, hexRgb: hexRgb, rgbHex: rgbHex,
    botSessState: botSessState, botFace: botFace, BOT_STATE_FACE: BOT_STATE_FACE,
    BOT_ROLE_RULES: BOT_ROLE_RULES, BOT_ROLE_DEFAULT: BOT_ROLE_DEFAULT, botRole: botRole, botTeamKey: botTeamKey, normBotTeam: normBotTeam, botTeamJson: botTeamJson,
    checkBotTeamEdit: checkBotTeamEdit, applyBotTeamEdit: applyBotTeamEdit, botHeadFor: botHeadFor, BOT_TEAM_MAX: BOT_TEAM_MAX, botTurnDone: botTurnDone, BOT_LONG_TURN_MS: BOT_LONG_TURN_MS,
    SESS_VIEWS: SESS_VIEWS, SESS_VIEW_DEFAULT: SESS_VIEW_DEFAULT, normSessView: normSessView, isSessView: isSessView,
    STATES: STATES, LABEL: LABEL, coreState: coreState, caption: caption, vpBadge: vpBadge, VP_SHOW_MS: VP_SHOW_MS, VP_MIN_MS: VP_MIN_MS, CAPTION_REST_MS: CAPTION_REST_MS, captionRests: captionRests, captionRestIn: captionRestIn, composerCalm: composerCalm, lastSentence: lastSentence, gist: gist,
    needQueue: needQueue, card: card, doneText: doneText, approvalFrom: approvalFrom, approvalNoRule: approvalNoRule, get HELLO_HINT() { return helloHint(); },
    TOK_KEYS: TOK_KEYS, tokens: tokens, tokLine: tokLine, tokTip: tokTip,
    SHEETS: SHEETS, sheetKeys: sheetKeys,
    normName: normName, makeAliases: makeAliases, resolveTarget: resolveTarget, resolveFrom: resolveFrom, ghostWhere: ghostWhere,
    ATTACH_MAX_BYTES: ATTACH_MAX_BYTES, ATTACH_MAX_FILES: ATTACH_MAX_FILES, ATTACH_EXT: ATTACH_EXT, ATTACH_ACCEPT: ATTACH_ACCEPT, attachExt: attachExt, attachSize: attachSize, attachRefusal: attachRefusal, pastedName: pastedName, splitAttached: splitAttached,
  };
});
