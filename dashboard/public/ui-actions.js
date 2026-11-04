/*
 * What JOYA AI's voice may do on the Command Center screen (UI control,
 * Phase 1: the desk's ui_action tool). One allowlist, required by the server
 * (lib/voice-live.js, lib/voice-desk.js) and loaded by the page (joya-ai.js),
 * so both sides refuse the same things. Pure: no DOM, no state.
 *
 * Tier 1 only -- harmless, instant, shown with a toast (and an undo where
 * sensible). Nothing here can approve or deny anything, touch keys, users,
 * rules, the gate, settings values, restarts or deploys: those have no action
 * name at all, so nothing can reach them whatever the model is told. A card
 * can be SHOWN (decision.show); pressing Approve stays a human click. The
 * microphone can be muted by voice but never unmuted (a hijacked turn must
 * not turn a muted microphone back on).
 *
 *   UiActions.validate(name, args) -> { ok: true, action, args } | { ok: false, why }
 *   UiActions.toast(action, args)  -> "Joya opened Missions"
 *   UiActions.tool()               -> the realtime tool definition (ui_action)
 *   UiActions.limiter()            -> per-turn / per-minute rate limits
 *   UiActions.setPages(list|null)  -> the page map page.open uses (lib/page-registry.js)
 *
 * Where an action runs: "server" (the live call itself: end, mute, interrupt)
 * or "page" (the tab that holds the call, or that sent the relay-desk turn).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UiActions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The dock's sheets (public/cc-logic.js SHEETS), plus the phone's Everything grid.
  var SHEETS = {
    conv: "Conversation", sessions: "Sessions", missions: "Missions", dec: "Decisions",
    tl: "Timeline", rules: "Rules & alerts", orders: "Schedules (in Rules & alerts)", cost: "Usage",
    machine: "Machine", everything: "Everything",
  };
  // The words people use for each panel (English and Egyptian Arabic), for the tool's description.
  var PANEL_WORDS = [
    "conv = the chat panel (الشات)",
    "sessions (الجلسات، السيشنز)",
    "missions (المهام، الميشنز)",
    "dec = decisions / approvals (القرارات، الموافقات)",
    "tl = timeline / activity (التايم لاين، السجل)",
    "rules = rules & alerts: approval rules and system alerts (القواعد، التنبيهات، الووتشرز)",
    "orders = schedules / standing orders, a tab of rules & alerts (الأوامر الدائمة، الأوردرز، المواعيد)",
    "cost = cost & voice usage (التكلفة، المصاريف)",
    "machine = the machine / server (الماشين، السيرفر)",
    "everything (كل حاجة)",
  ].join("; ");
  // A, B and C were retired on 2026-10-25 (dashboard public/cc-logic.js).
  var CORES = { D: "D", E: "E" };
  // Tier 2 (UI control Phase 3): preferences, applied only after a confirm the server checks.
  var THEMES = { system: "the system theme", dark: "the dark theme", light: "the light theme" };
  // lib/voice-persona.js PRESETS plus "learned" (tested to match).
  var PERSONAS = { cairene_f: "Cairene Egyptian, feminine", cairene_m: "Cairene Egyptian, masculine", msa_n: "Modern Standard Arabic, neutral", learned: "learned from how you speak" };
  // lib/voice.js VOICES (tested to match).
  var VOICE_NAMES = { marin: "marin", cedar: "cedar", alloy: "alloy", ash: "ash", ballad: "ballad", coral: "coral", echo: "echo", sage: "sage", shimmer: "shimmer", verse: "verse" };
  var VIEWS = { map: "the map", missions: "Missions" };

  /*
   * page.open: the page map (lib/page-registry.js) -- every page, Settings
   * section, Command Center sheet, tab and card anchor JOYA AI may open, built
   * from the source and allowed entry by entry in Settings > Screen control.
   * The panel hands the current map to the supervisor (op ui-pages) and to each
   * page (data-page-map), and both call setPages(); until then the built-in
   * pages below stand in. Entries are GET pages only (none has a side effect);
   * a url is never taken from the model, only from the map. perm: what the page
   * needs (checked on the page before it moves; null = anyone signed in).
   * Nothing on a page is ever clicked for them.
   */
  var BUILTIN_PAGES = {
    cc: { url: "/joya-ai", label: "Command Center", perm: "joyaai.use", kind: "page" },
    settings: { url: "/joya-ai/settings", label: "JOYA AI Settings", perm: "joyaai.use", kind: "page" },
    "settings.voice": { url: "/joya-ai/settings/voice", label: "Voice settings", perm: "voice.manage", kind: "section" },
    agents: { url: "/agents/dashboard", label: "Agents overview", perm: "agents.view", kind: "page" },
    sessions: { url: "/claude/sessions", label: "Sessions", perm: "claude.sessions.view", kind: "page" },
    "sessions.live": { url: "/claude/sessions?tab=live", label: "Live sessions", perm: "claude.running.view", kind: "tab" },
    telegram: { url: "/agents", label: "Telegram agents", perm: "agents.view", kind: "page" },
    channels: { url: "/channels", label: "Channels", perm: "channels.view", kind: "page" },
    addons: { url: "/addons", label: "Add-ons", perm: "addons.view", kind: "page" },
    memory: { url: "/claude/memory", label: "Memory", perm: "claude.memory.read", kind: "page" },
    os: { url: "/os", label: "Machine health", perm: "os.view", kind: "page" },
    services: { url: "/services", label: "Services", perm: "services.view", kind: "page" },
    "services.agents": { url: "/services?kind=agents", label: "Agent services", perm: "agents.view", kind: "tab" },
    audit: { url: "/audit", label: "Audit log", perm: "audit.view", kind: "page" },
    users: { url: "/users", label: "Users", perm: "users.view", kind: "page" },
    roles: { url: "/roles", label: "Roles", perm: "roles.view", kind: "page" },
    devices: { url: "/devices", label: "Signed-in devices", perm: null, kind: "page" },
    keys: { url: "/keys", label: "SSH keys", perm: "keys.view", kind: "page" },
    firewall: { url: "/firewall", label: "Firewall", perm: "firewall.view", kind: "page" },
    credentials: { url: "/credentials", label: "Credentials", perm: "credentials.view", kind: "page" },
    guide: { url: "/guide", label: "Guide", perm: null, kind: "page" },
    account: { url: "/account", label: "Your account", perm: null, kind: "page" },
  };
  // page.open's keys before the page map, and the entries they became (still accepted).
  var LEGACY_PAGES = {
    "os-overview": "os", "agents-fleet": "telegram", "agents-channels": "channels", "agents-addons": "addons",
    "agents-services": "services.agents", "os-services": "services", "os-audit": "audit", "os-firewall": "firewall",
    "manage-credentials": "credentials", "manage-ssh-keys": "keys", "manage-devices": "devices", "manage-users": "users",
    "manage-roles": "roles", "claude-memory": "memory", "claude-sessions": "sessions", "claude-running": "sessions.live",
    "voice-settings": "settings.voice", "command-center": "cc",
  };
  var NAV_PAGES = BUILTIN_PAGES;
  var PAGE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

  /**
   * The page map in use: [{key, label, url, perm, kind, parent}] (the panel's
   * allowed entries), or null for the built-in pages. Bad entries are skipped:
   * a url must be a path of this site.
   */
  function setPages(list) {
    if (!Array.isArray(list)) { NAV_PAGES = BUILTIN_PAGES; return Object.keys(NAV_PAGES).length; }
    var m = {};
    list.forEach(function (e) {
      if (!e || typeof e.key !== "string" || !PAGE_KEY.test(e.key) || typeof e.url !== "string" || !/^\/(?!\/)[^\s"'<>\\]{0,300}$/.test(e.url)) return;
      m[e.key] = { url: e.url, label: String(e.label || e.key).slice(0, 120), perm: e.perm || null, kind: e.kind || "page", parent: e.parent || null };
    });
    NAV_PAGES = m;
    return Object.keys(m).length;
  }
  function pageKey(key) {
    if (typeof key !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(NAV_PAGES, key)) return key;
    var to = Object.prototype.hasOwnProperty.call(LEGACY_PAGES, key) ? LEGACY_PAGES[key] : null;
    return to && Object.prototype.hasOwnProperty.call(NAV_PAGES, to) ? to : null;
  }
  // page.open's argument: a free string checked against the map at call time.
  function pageArg(a) {
    var k = pageKey(a && a.page);
    return k ? { page: k } : null;
  }

  function oneOf(map, key) {
    return function (a) {
      var v = a && a[key];
      return typeof v === "string" && Object.prototype.hasOwnProperty.call(map, v) ? (function () { var o = {}; o[key] = v; return o; })() : null;
    };
  }
  function none(a) {
    return a && typeof a === "object" && Object.keys(a).some(function (k) { return a[k] !== undefined && a[k] !== null && a[k] !== ""; }) ? null : {};
  }

  function optKey(a) {
    var x = a && typeof a === "object" ? a : {};
    var extra = Object.keys(x).some(function (k) { return k !== "key" && x[k] !== undefined && x[k] !== null && x[k] !== ""; });
    if (extra) return null;
    if (x.key === undefined || x.key === null || x.key === "") return {};
    return Object.prototype.hasOwnProperty.call(SHEETS, x.key) ? { key: x.key } : null;
  }

  var ACTIONS = {
    "call.end": { tier: 1, where: "server", once: true, args: none, toast: function () { return "Joya ended the call"; } },
    // Mute only: `on` must be true (or absent). Unmuting is by hand.
    "call.mute": {
      tier: 1, where: "server",
      args: function (a) { var on = a && a.on; return on === undefined || on === null || on === true || on === "true" ? { on: true } : null; },
      why: "the microphone can be muted by voice, never unmuted -- the administrator unmutes it by hand",
      toast: function () { return "Joya muted the microphone"; },
    },
    "call.interrupt": { tier: 1, where: "server", args: none, toast: function () { return "Joya stopped reading"; } },
    "sheet.open": { tier: 1, where: "page", args: oneOf(SHEETS, "key"), toast: function (a) { return "Joya opened " + SHEETS[a.key]; } },
    // key is optional: "close the missions" may name the panel it closes.
    "sheet.close": { tier: 1, where: "page", args: optKey, toast: function (a) { return a.key ? "Joya closed " + SHEETS[a.key] : "Joya closed the panel"; } },
    view: { tier: 1, where: "page", args: oneOf(VIEWS, "name"), toast: function (a) { return "Joya showed " + VIEWS[a.name]; } },
    "core.set": { tier: 1, where: "page", args: oneOf(CORES, "core"), toast: function (a) { return "Joya switched the core to " + a.core; } },
    "reply.show": { tier: 1, where: "page", args: none, toast: function () { return "Joya opened the last reply"; } },
    "reply.read": { tier: 1, where: "page", args: none, toast: function () { return "Joya is reading the last reply"; } },
    "decision.show": { tier: 1, where: "page", args: none, toast: function () { return "Joya showed the waiting card -- approving it is yours"; } },
    // Takes the administrator to one entry of the page map (M-5). Once a turn.
    "page.open": { tier: 1, where: "page", once: true, args: pageArg, why: "no such page in the page map (see ui_actions_list)", toast: function (a) { var p = navPage(a.page); return "Joya opened " + (p ? p.label : a.page); } },
    // Tier 2: the toast is the question; done() is what is shown once confirmed and applied.
    "theme.set": { tier: 2, where: "page", args: oneOf(THEMES, "theme"), toast: function (a) { return "Switch to " + THEMES[a.theme] + "?"; }, done: function (a) { return "Switched to " + THEMES[a.theme]; } },
    "persona.set": { tier: 2, where: "page", args: oneOf(PERSONAS, "preset"), toast: function (a) { return "Set the voice persona to " + PERSONAS[a.preset] + "?"; }, done: function (a) { return "Voice persona: " + PERSONAS[a.preset]; } },
    "voice.set": { tier: 2, where: "page", args: oneOf(VOICE_NAMES, "voice"), toast: function (a) { return "Switch the voice to " + a.voice + "? (for everyone; an open call reconnects with it)"; }, done: function (a) { return "The voice is now " + a.voice; } },
  };

  function names() { return Object.keys(ACTIONS); }

  /** Is this a known action with good arguments? Unknown names are refused, whatever they are. */
  function validate(name, args) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(ACTIONS, name)) return { ok: false, why: "no such screen action (allowed: " + names().join(", ") + ")" };
    var a = ACTIONS[name];
    var clean = a.args(args && typeof args === "object" && !Array.isArray(args) ? args : {});
    if (!clean) return { ok: false, why: a.why || "bad arguments for " + name };
    return { ok: true, action: name, args: clean, where: a.where, tier: a.tier, once: !!a.once };
  }

  /** Tier 2: the line shown once the change is confirmed and applied. */
  function doneText(name, args) {
    var a = ACTIONS[name];
    return a && a.done ? a.done(args || {}) : toast(name, args);
  }

  function toast(name, args) {
    var a = ACTIONS[name];
    return a ? a.toast(args || {}) : "";
  }

  /** page.open: { url, label, perm, kind } for a key of the page map (or an old key), or null. */
  function navPage(key) {
    var k = pageKey(key);
    return k ? NAV_PAGES[k] : null;
  }
  /** The page.open keys a viewer may use, given can(perm). */
  function navKeysFor(can) {
    return Object.keys(NAV_PAGES).filter(function (k) { var p = NAV_PAGES[k].perm; return !p || !!can(p); });
  }
  /** The page map in use, as { key: { url, label, perm, kind, parent } }. */
  function pages() { return NAV_PAGES; }

  /**
   * The realtime tool. Flat, optional arguments so the model can fill them
   * without nesting: action, and key / mode / name / core / page as the
   * action needs.
   */
  function tool() {
    return {
      type: "function",
      name: "ui_action",
      description:
        "Change what the administrator sees on this Command Center screen, at once: end or mute this call (never unmute), stop reading, " +
        "open or close a panel (" + Object.keys(SHEETS).join(", ") + "), show the map or missions, switch the core (D mesh / E bot), " +
        "show or read the last reply, or show the waiting decision card. " +
        "page.open takes the administrator to a page, a Settings section, a tab or a card of Joya (page = one key of the page map: " + Object.keys(NAV_PAGES).join(", ") + "): " +
        "\"open the machine overview\" / «افتحلي الـ OS dashboard» -> os; \"agents and sessions\" -> agents; \"the Telegram agents\" -> telegram; \"users\" -> users; \"the voice settings\" -> settings.voice; " +
        "\"back to the Command Center\" -> cc. It only opens the page (nothing on it is clicked), is refused when their role cannot see that page, and is once a turn. " +
        "Panel names as the administrator may say them: " + PANEL_WORDS + ". " +
        "\"Close the missions\", \"hide the decisions\", «اقفلي المهام», «اقفل الميشنز», «شيل القرارات» close that PANEL (sheet.close), never the call: " +
        "call.end only when they name the call or the conversation (\"end the call\", «اقفل المكالمة»). " +
        "Three preferences need the administrator's own confirmation: theme.set (system/dark/light -- \"dark mode\", «دارك», «الوضع الليلي»), " +
        "persona.set (the Arabic voice persona: cairene_f = Egyptian woman «مصرية بنت», cairene_m = Egyptian man «مصري ولد», msa_n = formal Arabic «فصحى», learned = learn from how I speak) and voice.set " +
        "(the voice's sound, for everyone; after the confirm any open live call reconnects in the new voice by itself). For those the result is status \"confirm\": nothing has changed yet -- say only that you are waiting for their confirmation (\"Waiting for your confirmation.\"); never tell them to say yes. " +
        "Never say it is done until they have confirmed, and never confirm for them. " +
        "It cannot approve, deny or confirm anything, change keys, users, rules, other settings, restart or deploy: approving stays the administrator's click. " +
        "Use it only when the administrator asks for it in this turn.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: names() },
          key: { type: "string", enum: Object.keys(SHEETS), description: "sheet.open: which panel; sheet.close: optional, the panel named" },
          name: { type: "string", enum: Object.keys(VIEWS), description: "view" },
          core: { type: "string", enum: Object.keys(CORES), description: "core.set" },
          page: { type: "string", description: "page.open: one key of the page map (listed in this tool's description)" },
          theme: { type: "string", enum: Object.keys(THEMES), description: "theme.set (needs confirm)" },
          preset: { type: "string", enum: Object.keys(PERSONAS), description: "persona.set (needs confirm)" },
          voice: { type: "string", enum: Object.keys(VOICE_NAMES), description: "voice.set (needs confirm; an open call reconnects with it)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    };
  }

  // Fixed for ever (ui_do's schema): "mode" stays though voice.mode is gone.
  var ARG_KEYS = ["key", "mode", "name", "core", "page", "on", "theme", "preset", "voice"];

  /*
   * JOYA AI's MCP tools (bin/joya-ai-mcp). A resumed claude CLI keeps the
   * schema it first loaded for a tool (its deferred_tools_record), so the MCP
   * tool's schema must never change when an action or a page is added: `ui_do`
   * takes `action` as a plain string and every argument as a plain field
   * (ARG_KEYS, a fixed superset), and validation stays where it is (validate(),
   * on the supervisor and again on the page). What exists right now is read at
   * run time from `ui_actions_list` (catalog() below).
   */
  var WHAT = {
    "call.end": "end the administrator's live voice call",
    "call.mute": "mute their microphone in the live call (never unmute)",
    "call.interrupt": "stop reading aloud",
    "sheet.open": "open a Command Center panel",
    "sheet.close": "close the open panel (or the panel named, if it is the one open)",
    view: "show the map or the missions",
    "core.set": "switch the Command Center core",
    "reply.show": "open your last reply in full",
    "reply.read": "read your last reply aloud",
    "decision.show": "show the waiting decision card (approving it stays theirs)",
    "page.open": "take the administrator to a page, Settings section, tab or card of Joya (only the page opens; refused when their role cannot see it)",
    "theme.set": "ask to switch the theme (they confirm)",
    "persona.set": "ask to set the Arabic voice persona (they confirm)",
    "voice.set": "ask to switch the voice's sound, for everyone (they confirm; an open call reconnects in it)",
  };
  function labels(map, f) { var o = {}; Object.keys(map).forEach(function (k) { o[k] = f ? f(map[k], k) : map[k]; }); return o; }
  var ARG_SPEC = {
    "call.mute": { on: { required: false, values: { "true": "mute (the only value)" } } },
    "sheet.open": { key: { required: true, values: SHEETS } },
    "sheet.close": { key: { required: false, values: SHEETS } },
    view: { name: { required: true, values: VIEWS } },
    "core.set": { core: { required: true, values: CORES } },

    "theme.set": { theme: { required: true, values: THEMES } },
    "persona.set": { preset: { required: true, values: PERSONAS } },
    "voice.set": { voice: { required: true, values: VOICE_NAMES } },
  };
  /** ui_actions_list: the live allowlist -- actions, tiers, arguments and values, which need a confirm. */
  function catalog() {
    return {
      call_with: "ui_do, with action and its arguments as plain fields, e.g. {\"action\": \"page.open\", \"page\": \"os-audit\"}",
      rules: [
        "Only while you answer a request the administrator sent from the Command Center or the JOYA AI dock, and only when they asked for it in that request.",
        "It acts on the tab they asked from. It never approves, denies or confirms anything, and never changes keys, users, rules or other settings.",
        "Tier 2 (needs_confirm): the result is status confirm -- nothing has changed yet; say only that you are waiting for their confirmation (never tell them to say yes); never confirm for them.",
        "The result is ok, refused (with why), confirm or no-screen; say what really happened.",
        "At most 6 a request and 20 a minute; an action marked once works once a request.",
      ],
      actions: names().map(function (n) {
        var a = ACTIONS[n];
        var args = ARG_SPEC[n] || {};
        // The page map changes as Joya grows (Settings > Screen control): read it now.
        if (n === "page.open") args = { page: { required: true, values: labels(NAV_PAGES, function (p) { return p.label + (p.kind && p.kind !== "page" ? " [" + p.kind + "]" : "") + (p.perm ? " (needs " + p.perm + ")" : ""); }) } };
        return { action: n, what: WHAT[n] || "", tier: a.tier, needs_confirm: a.tier === 2, once_per_request: !!a.once, args: args };
      }),
    };
  }
  /** ui_do's input schema: fixed forever (a snapshot test holds it). */
  function stableSchema() {
    var p = { action: { type: "string", description: "An action name from ui_actions_list." } };
    ARG_KEYS.forEach(function (k) { p[k] = k === "on" ? { type: "boolean", description: "call.mute only: true (muting; never unmuting)" } : { type: "string", description: "As ui_actions_list gives for the action." }; });
    return { type: "object", properties: p, required: ["action"], additionalProperties: false };
  }
  /** The tool's flat arguments split into action and args. */
  function fromTool(args) {
    var a = args && typeof args === "object" ? args : {};
    var out = {};
    ARG_KEYS.forEach(function (k) { if (a[k] !== undefined) out[k] = a[k]; });
    var extra = Object.keys(a).filter(function (k) { return k !== "action" && ARG_KEYS.indexOf(k) < 0; });
    return { action: a.action, args: out, extra: extra };
  }

  /**
   * Rate limits: at most `perTurn` actions per turn and `perMinute` per
   * minute, and a `once` action (call.end, page.open) once per turn.
   */
  function limiter(opts) {
    var o = opts || {};
    var perTurn = o.perTurn || 6, perMinute = o.perMinute || 20;
    var times = [];
    var turns = {};
    return {
      take: function (turnKey, action, now) {
        var t = now || Date.now();
        times = times.filter(function (x) { return t - x < 60000; });
        var k = String(turnKey || "");
        var tu = turns[k] || (turns[k] = { n: 0, once: {} });
        if (times.length >= perMinute) return "too many screen actions this minute";
        if (tu.n >= perTurn) return "too many screen actions in one turn";
        if (ACTIONS[action] && ACTIONS[action].once && tu.once[action]) return action + " was already done in this turn";
        times.push(t);
        tu.n++;
        tu.once[action] = true;
        var keys = Object.keys(turns);
        if (keys.length > 50) delete turns[keys[0]];
        return null;
      },
    };
  }

  // What a claim of a screen action sounds like: "I opened Missions", «فتحتلك الـ missions».
  // (The desk's guard allows it only when a ui_action in this turn returned ok.)
  var CLAIM_EN = /\b(?:i|i've|ive|i have|i just|i've just)\s+(?:just\s+|now\s+)?(?:opened|closed|muted|ended|switched|showed|shown|brought up|pulled up|put up|hung up|interrupted|stopped reading|set|changed|turned)\b/;
  var CLAIM_AR = /(?:^|[^ء-ي])[وف]?(?:فتحت|فتحتلك|فتحتهالك|ا?قفلت|ا?قفلتلك|قفلتهالك|كتمت|نهيت|انهيت|غيرت|غيرتلك|حولت|حولتلك|عرضت|عرضتلك|طلعتلك|وقفت\s+القرايه|سكرت)(?:[ء-ي]*)/;
  function claims(normText) {
    // Diacritics, tatweel and alef forms out, so «قفّلت» and «أقفلت» read as written plainly.
    var t = String(normText || "").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627");
    return CLAIM_EN.test(t) || CLAIM_AR.test(t);
  }

  return {
    ACTIONS: ACTIONS, SHEETS: SHEETS, CORES: CORES, VIEWS: VIEWS, THEMES: THEMES, PERSONAS: PERSONAS, VOICE_NAMES: VOICE_NAMES, ARG_KEYS: ARG_KEYS,
    BUILTIN_PAGES: BUILTIN_PAGES, LEGACY_PAGES: LEGACY_PAGES,
    names: names, validate: validate, toast: toast, doneText: doneText, navPage: navPage, navKeysFor: navKeysFor, pages: pages, setPages: setPages, tool: tool, fromTool: fromTool, catalog: catalog, stableSchema: stableSchema, limiter: limiter, claims: claims,
  };
});
