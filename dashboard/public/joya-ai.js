"use strict";
/*
 * The JOYA AI Command Center, live (the simplified Joya layout).
 *
 * Reads the JSON API under /joya-ai/api/ once on load (overview, the turns,
 * approvals, delegations and inbound ledgers, then missions, decisions,
 * watchers, rules, standing orders and cost through cc-panels.js), then follows
 * the supervisor's event stream over Server-Sent Events. Everything on screen
 * is built here from that data, and every string that came from the server
 * goes through esc() or the console's markdown renderer (MD, from console.js),
 * which escapes first. Sizes that depend on data are set through element.style
 * after the markup is in place (applyBars), never as a style attribute: the
 * CSP would refuse it.
 *
 * The screen: the JOYA AI core in the middle (joya-core.js, placed and fed by
 * cc-map.js) with the live sessions as points on its orbit; one caption under
 * it; one pill composer; the dock on the left opening sheets from the right;
 * one decision card top right. What the core and the caption show is decided
 * in one place, cc-logic.js (JoyaLogic.caption), from real events -- the
 * running turn and its current step, a SendMessage delegation and its target
 * (the stream of dots flies to that session), the sentence being read aloud
 * (its words appear as it is spoken), the microphone, and anything waiting
 * for a decision.
 *
 * The missions board, the Decisions inbox, Rules and Watchers, the standing
 * orders, the cost view, the session deep view and the Ctrl+K palette are
 * cc-panels.js, handed this file's helpers and state (the CC object below).
 *
 * Voice goes through OpenAI, on the server only, and is live conversation
 * (public/voice-live.js, the live block below): the mic starts a call. While a call is on, each reply
 * it says is put on screen in full (callReply: the reply panel, or the dock's reply card over a page or
 * a sheet) and the call is told so; the page and panel in view go to the call too (screenTick), so JOYA
 * AI can answer "what's on my screen" for Joya pages. Replies
 * can also be read aloud: each sentence is posted to /joya-ai/api/speak, whose
 * audio streams back as PCM chunks (NDJSON) and starts playing with the first
 * one. With voice off in Settings, no key, or no voice.use, the page carries
 * no mic and no read-aloud at all.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
 *
 * Loaded only on the Command Center (html.cc-page); returns at once elsewhere.
 */
(function () {
  var root = document.getElementById("cc");
  if (!root) return;

  var CSRF = root.getAttribute("data-csrf") || "";
  var VIEWER = root.getAttribute("data-viewer") || "you";
  // Voice works for this viewer: switched on in Settings ▸ Voice, a key set, and voice.use.
  var READY = root.getAttribute("data-voice-ready") === "1";
  var VOICE = root.getAttribute("data-voice") || "";
  // The desktop app's render mode (/joya-ai?shell=desktop; public/joya-desktop.js lays it out).
  var DESKTOP = root.getAttribute("data-shell") === "desktop";

  /* ================================================================ helpers */

  function $(id) { return document.getElementById(id); }
  /** A live conversation is on (the live integration block, further down; never in a sandbox without it). */
  function liveActive() { return typeof LiveUI !== "undefined" && !!(LiveUI && LiveUI.active); }
  /** The live call's microphone or speaker loudness, for the core. */
  function liveLevel(k) { return liveActive() ? Math.min(1, (LiveUI[k] || 0) * (k === "mic" ? 3 : 2.5)) : 0; }
  /* This tab's id (per tab, sessionStorage): sent with every request to JOYA AI
     so that its screen actions (UI control Phase 2) come back to this tab only. */
  var TAB_ID = (function () {
    var fresh = "t" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try {
      var t = window.sessionStorage.getItem("joya-tab");
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(t || "")) { t = fresh; window.sessionStorage.setItem("joya-tab", t); }
      return t;
    } catch (e) { return fresh; }
  })();
  // ("Stop listening" and "undo" said aloud are caught by the server in the live call:
  // public/voice-stop.js there, and the call sends "stop" / "ui-undo".)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(name, cls) {
    return '<svg class="cc-i' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="#cc-i-' + name + '"/></svg>';
  }
  function md(text) {
    try {
      if (typeof window.MD === "function") return window.MD(String(text || ""));
    } catch (e) { /* fall through to plain text */ }
    return "<p>" + esc(text).replace(/\n/g, "<br>") + "</p>";
  }
  function num(n) { return n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("en-US"); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function firstLine(s) { return String(s || "").split("\n").filter(function (l) { return l.trim(); })[0] || ""; }
  /** Plain text of a markdown reply, for one-line previews. */
  function plain(s) {
    return String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[#>*+-]+\s*/gm, "").replace(/[*_~|]/g, "").replace(/\s+/g, " ").trim();
  }

  var TZ = "Africa/Cairo";
  var fmtHMS, fmtHM, fmtDate, fmtDay;
  try {
    fmtHMS = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    fmtHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    fmtDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
    fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
  } catch (e) {
    fmtHMS = fmtHM = fmtDate = fmtDay = new Intl.DateTimeFormat("en-GB");
  }
  function t(iso) { var d = iso ? new Date(iso) : null; return d && isFinite(d) ? d : null; }
  function hm(iso) {
    var d = t(iso); if (!d) return "";
    // Older than today: the date says more than the time.
    return Date.now() - d.getTime() > 20 * 3600 * 1000 ? fmtDay.format(d) : fmtHM.format(d);
  }
  function hms(iso) { var d = t(iso); return d ? fmtHMS.format(d) : ""; }
  /** Day and time together, for anything that may be days away (next runs). */
  function when(iso) { var d = t(iso); return d ? fmtDay.format(d) + " " + fmtHM.format(d) : ""; }
  function ago(iso) {
    var d = t(iso); if (!d) return "";
    var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function dur(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function upDur(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? "up " + d + "d " + h + "h" : h ? "up " + h + "h " + m + "m" : "up " + m + "m";
  }
  function bytesGB(n) { return n ? Math.round(n / 1073741824) + " GB" : ""; }
  function modelLabel(id) {
    var m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id || ""));
    if (!m) return String(id || "");
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] && m[3].length < 3 ? "." + m[3] : "");
  }
  function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }
  /** Widths, custom properties and offsets that depend on data, set after the
      markup is in place (a style attribute would be refused by the CSP). */
  function applyBars(el) {
    if (!el) return;
    var i, list = el.querySelectorAll("[data-w]");
    for (i = 0; i < list.length; i++) list[i].style.width = pct(list[i].getAttribute("data-w")) + "%";
    list = el.querySelectorAll("[data-v]");
    for (i = 0; i < list.length; i++) list[i].style.setProperty("--v", pct(list[i].getAttribute("data-v")) + "%");
    list = el.querySelectorAll("[data-l]");
    for (i = 0; i < list.length; i++) list[i].style.left = pct(list[i].getAttribute("data-l")) + "%";
  }

  var toastTimer = 0;
  // While another page is up in the shell (M-5 part 2), the Command Center is under it: its notes go to the dock.
  function shellUp() { return !!(window.JoyaShell && window.JoyaShell.active()); }
  function toast(text, bad) {
    // Eye contact (joya-presence-bind.js): while the camera sees you away, notes are held for one summary.
    if (window.JoyaPresenceHold && window.JoyaPresenceHold.toast(text, bad)) return;
    if (shellUp()) return window.JoyaShell.toast(text, null, null, bad);
    var old = document.querySelector(".cc-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "cc-toast" + (bad ? " bad" : "");
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, bad ? 5000 : 2600);
  }

  /**
   * A streamed API call (NDJSON): `onEvent` gets each object as it arrives;
   * resolves with the last {type:"done"}. A refusal before the stream starts
   * rejects like api() does, with .status and .code.
   */
  function apiStream(path, body, onEvent) {
    return fetch("/joya-ai/api/" + path, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/x-ndjson", "Content-Type": "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.error || "HTTP " + r.status);
          e.status = r.status; e.code = j.code;
          throw e;
        });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", done = null;
      function take(line) {
        if (!line.trim()) return;
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === "error" || ev.type === "refused") { var err = new Error(ev.error || "error"); err.code = ev.code; err.refused = ev.type === "refused"; throw err; }
        if (ev.type === "done") done = ev;
        onEvent(ev);
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.value) {
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
          }
          if (x.done) { take(buf); return done || {}; }
          return pump();
        });
      }
      return pump();
    });
  }

  /** JSON API call. Writes carry the CSRF token in a header. */
  function api(path, opts) {
    opts = opts || {};
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (opts.body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.headers["X-CSRF-Token"] = CSRF;
      init.body = JSON.stringify(opts.body);
    }
    return fetch("/joya-ai/api/" + path, init).then(function (r) {
      if (opts.raw) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || "HTTP " + r.status); });
        return r;
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || "HTTP " + r.status);
          e.status = r.status; e.code = j.code;
          if (j.step_up) e.stepUp = j.step_up;
          // Windows Hello for an approval (lib/stepup.js): the first try names the challenge; ask, and send again with the proof.
          if (r.status === 428 && j.step_up && !opts.stepped && window.JoyaStepUp) {
            return window.JoyaStepUp.ask(j.step_up, function (proof) {
              var o = {};
              for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
              o.body = Object.assign({}, opts.body || {}, { step_up: proof });
              o.stepped = true;
              return api(path, o);
            });
          }
          throw e;
        }
        return j;
      });
    });
  }

  /* ================================================================ state */

  var S = {
    online: false,
    liveReplies: new Set(), // turn ids whose reply arrived live in this page's life (the only ones the caption shows)
    offlineMsg: "",
    status: null,          // the supervisor's status
    sessions: [],          // claude agents --json merged with the ledger
    memory: null,
    agents: null,
    turns: new Map(),      // id -> turn row + live parts
    turnOrder: [],         // ids, oldest first
    oldestTurn: null,
    delegations: new Map(),
    approvals: new Map(),
    inbound: new Map(),
    feed: [],              // {key, ts, kind, html}
    steps: null,           // {turn_id, steps}
    loadSeq: 0,            // events at or below this were replayed from the ring
    lastSeq: 0,
    skew: 0,               // server clock minus ours, ms
    target: "auto",
    delegatingUntil: 0,
    delegTo: "",           // the session the last delegation went to, and what it said
    delegText: "",
    spoken: "",            // the sentence being read aloud now
    pane: null,            // the open sheet: conv | sessions | missions | dec | tl | rules | cost | machine | everything
  };
  var ML = window.JoyaLogic;

  function nowServer() { return Date.now() + S.skew; }

  /* The assistant's names. It is JOYA AI now (JOYA AI until 2026-09-29, JOYA
     Bot before that); "joya-ai" is its internal id. Anything that asks "is this
     name us?" accepts all of them, so a session or a note still using the old
     name is never taken for another session. */
  var AI_NAME = "JOYA AI";
  function isAiName(n) {
    var k = String(n == null ? "" : n).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    return k === "joya ai" || k === "joya ai" || k === "joya bot";
  }
  /** How an actor / sender is shown: the assistant by its current name, anyone else as they are. */
  function aiLabel(n) { return isAiName(n) ? AI_NAME : n; }
  function liveSessions() { return S.sessions.filter(function (s) { return !s.self && !isAiName(s.name); }); }
  /** Take a sessions list from the server. JOYA AI itself is always shown,
      even when the list does not carry it (then it is made from the status),
      and a session the event did not tag with its mission gets it from the
      missions board. */
  function setSessions(list) {
    list = (list || []).slice();
    var st = S.status || {};
    if (!list.some(function (s) { return s.self; }) && (st.session_id || (st.process && st.process.pid))) {
      list.push({ self: true, synthetic: true, name: "JOYA AI", pid: st.process && st.process.pid, session_id: st.session_id || null,
        cwd: "/root/joya-ai", where: "headless · supervisor", kind: "supervisor", status: st.busy ? "busy" : "idle", subagents: [],
        started_at: st.process && st.process.started_at, tokens_today: st.tokens_today || null });
    }
    list.forEach(function (s) {
      if ((!s.mission || s.mission.derived) && !s.self && s.name && typeof P !== "undefined" && P) s.mission = P.missionFor(s.name);
      if (s.self && !s.tokens_today && st.tokens_today) s.tokens_today = st.tokens_today;
    });
    S.sessions = list;
    ALIAS.learnSessions(list);
    deskPing();
  }
  // Every name a session was known by (sessions events, delegation rows): an old name still finds it.
  var ALIAS = ML.makeAliases();
  function selfSession() { return S.sessions.filter(function (s) { return s.self; })[0] || null; }
  function sessState(s) { return s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle"; }
  /** The live session a delegation went to, by stable id first (cc-logic resolveTarget); null if none or ambiguous. */
  function sessionFor(d) { return ML.resolveTarget(d, S.sessions, ALIAS).session; }
  /** A live session by a UNIQUE normalised name (no [ref], case, spaces/dashes folded), or null. */
  function sessionNamed(name) {
    var n = ML.normName(name), m = S.sessions.filter(function (s) { return !s.self && ML.normName(s.name) === n; });
    return n && m.length === 1 ? m[0] : null;
  }
  function pendingApprovals() {
    var out = [];
    S.approvals.forEach(function (a) { if (a.status === "pending") out.push(a); });
    return out;
  }

  /* ================================================================ clock */

  function tick() {
    var d = new Date();
    $("cc-clock").textContent = fmtHM.format(d);
    $("cc-clock-date").textContent = fmtDate.format(d) + " · Cairo";
    tickApprovals();
    tickNeed();
  }

  /* ================================================================ theme
     The switch itself is the shell's (app.js); the canvas only has to repaint
     in the new palette when the theme, or the system's, changes. */

  document.addEventListener("joya-theme", function () { Orb.palette(); });

  /* ================================================================ sounds (2026-10-20)
     JOYA AI's sounds (public/joya-sound.js): the person's switch, volume and quiet hours (#cc data-sound,
     users.joya_sound), the desktop app follows them, a plain browser only once switched on there.
     Silent during a live call or while the voice speaks. The hooks: cc-map.js (the bot's chirps), the
     approvals, delegations and turns below. */
  var Snd = window.JoyaSound || null;
  function sound(name, role) { if (Snd && Snd.play) Snd.play(name, { role: role }); }
  if (Snd) {
    Snd.setPrefs(root.getAttribute("data-sound") || "");
    Snd.setHost({ desktop: DESKTOP });
    Snd.mutedBy(function () {
      if (liveActive()) return "call";
      if (typeof Voice !== "undefined" && Voice && Voice.speaking) return "speaking";
      return "";
    });
    // Changed in Settings (another tab, or the page in the shell's frame): take it now.
    window.addEventListener("storage", function (e) {
      if (e.key !== "joya-sound" || !e.newValue) return;
      try { var v = JSON.parse(e.newValue); if (v && v.sound) { Snd.setPrefs(v.sound); root.setAttribute("data-sound", JSON.stringify(Snd.prefs())); } } catch (x) { /* ignored */ }
    });
  }

  /* ================================================================ the core and its orbit */

  var Orb = window.JoyaMap({
    root: root, stage: $("cc-stage"), canvas: $("cc-core"), orbit: $("cc-orbit"), ring: $("cc-ring"), halo: $("cc-halo"),
    family: $("cc-family"), kids: $("cc-kids"), kcard: $("cc-kcard"),
  }, {
    onClick: function (key) { openSheet("sessions"); highlightSess(key); },
    // A sphere: its conversation (the existing deep view), or the sessions sheet if that is not there.
    onOpen: function (key) { if (window.JoyaStory && window.JoyaStory.openKey(key)) return; if (P && P.openDeep && findSess(key)) P.openDeep(key); else { openSheet("sessions"); highlightSess(key); } },
    onMenu: function (key, x, y) { sessMenu(key, x, y); },
    // The desktop app's render mode (?shell=desktop) places the core itself (public/joya-desktop.js).
    layoutOverride: function () { return DESKTOP && window.JoyaDesktop ? window.JoyaDesktop.coreLayout() : null; },
  });
  window.__joyaCC = {
    get core() { return Orb.core; }, orbit: Orb, S: S, renderSessions: function (f) { renderSessions(f); },
    /* For the desktop render mode: the last n exchanges as plain text ({id, me, ai}), oldest first. */
    recent: function (n) { return recentTurns(n); },
    /* For the desktop app's toast: Deny, through the same call the card's Deny makes (never approve). */
    decide: function (id, how) { return how === "deny" ? denyApproval(id) : Promise.resolve(null); },
    /* For the desktop app's glance cards: Approve, through the same call the cards make -- the server answers
       428 and step-up.js asks for Windows Hello (or the code) first; without a valid proof nothing is approved. */
    approve: function (id) { return approveApproval(id); },
    /* ...the decision card on one approval (the glance card's Open), a session's conversation, the server's clock. */
    openNeed: function (id) { openNeed(id ? "a" + Number(id) : undefined); },
    openSession: function (key) { var s = findSess(key); if (s && P && P.openDeep) P.openDeep(key); else { openSheet("sessions"); highlightSess(key); } },
    now: function () { return nowServer(); },
    /* The things a click on a session opens (the desktop render mode's checks drive them): its menu, the conversation, the retire dialog, a sheet. */
    get panels() { return P; },
    sessMenu: function (key, x, y) { return sessMenu(key, x, y); },
    retire: function (key) { var s = findSess(key); if (s && s.hire) retireDialog(s); },
    openSheet: function (id) { return openSheet(id); },
    /* The voiceprint's verdict as the live socket delivers it ({kind, gated}); the checks drive the pill with it. */
    voiceprint: function (m) { showVoiceprint(m || {}); },
    /* For proactive JOYA AI (public/joya-proactive.js): a line in the event log, a send that skipped its
       watcher check, and reading a brief aloud through the same read-aloud path as a reply. */
    feed: function (item, quiet) { feedPush(item, quiet); },
    send: function (text) { return send(text); },
    say: function (text) { if (READY) { Voice.unlock(); Voice.say(text); return true; } return false; },
    speaking: function () { return !!Voice.speaking; },
    stopSpeaking: function () { Voice.stop(); },
    /* Eye contact (joya-presence-bind.js): a reply read aloud pauses while you look away. */
    pauseSpeaking: function (on) { return Voice.pause ? Voice.pause(on) : false; },
  };

  /* ---- the core setting: A dotted sphere, B Siri fluid, C hybrid, D mesh (the default), E bot. The
     server rendered the saved one as data-core; this browser remembers it too
     (the fallback if the attribute is ever missing), and a switch here saves it
     for the person and swaps the running core in place, no reload. ---- */
  var CORE_KEY = "joya-core";
  function coreNow() { return Orb.core.S.concept; }
  (function () {
    var c = root.getAttribute("data-core");
    if (!c) { try { c = window.localStorage.getItem(CORE_KEY); } catch (e) { c = null; } }
    c = ML.normCore(c);
    Orb.setConcept(c);
    try { window.localStorage.setItem(CORE_KEY, c); } catch (e) { /* not remembered here; the server has it */ }
  })();
  /* Core E's head and colours changed in Settings (another tab, or the page in the shell's frame): take them now. */
  window.addEventListener("storage", function (e) {
    if (e.key !== "joya-bot" || !e.newValue) return;
    var b = null;
    try { b = JSON.parse(e.newValue); } catch (x) { b = null; }
    if (b && Orb.setBot) Orb.setBot(ML.isBotHead(b.head) ? b.head : null, b.colors ? ML.normBotColors(b.colors) : null);
  });
  /*
   * Core E's team (2026-10-20): each session's head wears its role's accessory (JoyaLogic.botRole), unless
   * the viewer pinned one in the Sessions sheet (users.joya_bot_team, POST prefs/bot-team; #cc data-bot-team).
   */
  var botTeam = ML.normBotTeam(root.getAttribute("data-bot-team") || "");
  function sessHead(s) { return ML.botHeadFor(s, botTeam); }
  function setSessHead(name, head) {
    var ed = ML.applyBotTeamEdit(botTeam, ML.botTeamKey(name), head || null);
    if (!ed.ok) { toast(ed.error, true); return; }
    botTeam = ed.team;
    root.setAttribute("data-bot-team", JSON.stringify(botTeam));
    renderSessions(true);
    api("prefs/bot-team", { body: { name: name, head: head || "" } }).then(function (r) {
      if (r && r.team) { botTeam = ML.normBotTeam(r.team); root.setAttribute("data-bot-team", JSON.stringify(botTeam)); }
      toast(clip(name, 30) + ": " + (head ? ML.BOT_HEADS[head] : "its role's head again"));
    }).catch(function (e) { toast("The head changed here, but was not saved: " + e.message, true); });
  }
  /** The Sessions sheet's head picker for one session (core E only). */
  function botPick(s) {
    if (coreNow() !== "E" || !s.name) return "";
    var b = sessHead(s);
    var o = '<option value="">Auto · ' + esc(ML.BOT_HEADS[b.auto]) + "</option>" +
      Object.keys(ML.BOT_HEADS).map(function (k) { return '<option value="' + k + '"' + (b.pinned && b.head === k ? " selected" : "") + ">" + esc(ML.BOT_HEADS[k]) + "</option>"; }).join("");
    return '<label class="cc-botpick" title="The head this session wears as a bot. Auto: its role\'s (' + esc(b.label) + ')">Bot <select data-bot-sess="' + esc(s.name) + '" aria-label="Bot head for ' + esc(s.name) + '">' + o + "</select></label>";
  }
  function paintCoreSwitches() {
    var bs = document.querySelectorAll("[data-core-set]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-checked", String(bs[i].getAttribute("data-core-set") === coreNow()));
  }
  function setCoreChoice(c) {
    c = ML.normCore(c);
    var was = coreNow();
    Orb.setConcept(c);
    paintCoreSwitches();
    if (c !== was) renderSessions(true); // core E adds a head picker to each session
    try { window.localStorage.setItem(CORE_KEY, c); } catch (e) { /* the server keeps it */ }
    if (c === was) return Promise.resolve(c);
    return api("prefs/core", { body: { core: c } }).then(function (r) {
      toast("JOYA AI core: " + c + " · " + ML.CORES[c]);
      return r && r.core;
    }).catch(function (e) {
      toast("The core switched here, but was not saved: " + e.message, true);
    });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-core-set]");
    if (b) { e.preventDefault(); setCoreChoice(b.getAttribute("data-core-set")); }
  });

  /* ================================================================ core state
     One place decides what the core shows and what the caption says:
     JoyaLogic.caption, from a snapshot of what is really happening. */

  var stateTimer = 0;
  function failedServices() {
    var m = S.status && S.status.machine;
    return (m && m.services && m.services.failed) || [];
  }
  /** The running turn's current step, in words (the last one still running). */
  function currentStep() {
    var cur = S.status && S.status.current_turn;
    if (!cur) return "";
    var steps = S.steps && S.steps.turn_id === cur.id ? S.steps.steps : cur.steps || [];
    for (var i = (steps || []).length - 1; i >= 0; i--) {
      var st = steps[i];
      if (st && (st.st === "run" || st.st === "wait")) return STEP_NAMES[st.txt] || st.txt;
    }
    var last = steps && steps.length ? steps[steps.length - 1] : null;
    return last ? STEP_NAMES[last.txt] || last.txt : "";
  }
  /** A session JOYA AI is waiting on: an open delegation from the running turn. */
  function waitingOn() {
    var cur = S.status && S.status.current_turn, out = "";
    if (!cur) return "";
    S.delegations.forEach(function (d) { if (d.turn_id === cur.id && (d.status === "sent" || d.status === "working")) out = d.target_name || out; });
    return out;
  }
  function lastReplyTurn() {
    for (var i = S.turnOrder.length - 1; i >= 0; i--) {
      var x = S.turns.get(S.turnOrder[i]);
      if (x && x.source !== "system" && x.status !== "running" && aiText(x)) return x;
    }
    return null;
  }
  function snapshot() {
    var busy = !!(S.status && S.status.busy), q = needQueue();
    var cur = S.status && S.status.current_turn, tr = cur ? S.turns.get(cur.id) : null;
    var last = lastReplyTurn(), vb = $("cc-vb-text");
    var dg = Date.now() < S.delegatingUntil;
    var snap = {
      online: S.online, offlineMsg: S.offlineMsg,
      listening: Voice.listening, speaking: Voice.speaking, voiceLive: $("cc-dock").classList.contains("voice-on"),
      voiceText: vb ? vb.textContent : "", spoken: S.spoken,
      busy: busy, stepText: currentStep(), waitingOn: waitingOn(), streamText: tr && tr.status === "running" && !Voice.speaking ? aiText(tr) : "",
      queued: (S.status && S.status.queue_depth) || 0,
      delegatingTo: dg ? S.delegTo : "", delegation: dg ? S.delegText : "",
      pending: q.length, needTitle: q.length ? (ML.card(q[0]) || {}).title : "",
      pausedAtCap: !!(S.status && S.status.paused_at_cap),
      // Only a reply that arrived live in this page's life is the caption; an old one (a reload, the
      // event ring's replay, a trip through the shell) is not repainted -- "See last reply" reaches it.
      lastReply: last && S.liveReplies.has(last.id) ? ML.gist(aiText(last)) : "",
    };
    return liveSnapshot(snap);
  }
  var capSig = "", capRestSig = "", capQuietSince = Date.now(), capRestTimer = 0;
  /** Activity: the caption's reply line comes back and the quiet spell starts again. */
  function capActivity() { capQuietSince = Date.now(); if (capSig) paintCaption(); }
  /* The voiceprint's verdict for the turn just heard (the relay's "voiceprint" event; only while the
     voiceprint is on): on the state pill for VP_SHOW_MS or until the state changes, then the state again. */
  var vpShown = null; // { badge, state, until }
  var vpTimer = 0;
  function showVoiceprint(m) {
    var b = ML.vpBadge(m.kind, !!m.gated, m.name, !!m.talkOnly);
    if (!b) return;
    var c = ML.caption(snapshot());
    vpShown = { badge: b, state: S.online ? c.state : "offline", at: Date.now(), until: Date.now() + ML.VP_SHOW_MS };
    var live = $("cc-vp-live");
    if (live) live.textContent = b.label + ".";
    // a voice turn dropped because the voice was not recognised: the bot shakes its head, and the camera's pill says
    // it too (it is what shows in Companion mode) -- the check itself stays
    if (m.kind === "other" && m.gated) {
      [Orb.core, window.JoyaDesktop && window.JoyaDesktop.companion ? (function () { try { var c = window.JoyaDesktop.companion(); return c && c.debug && c.debug.core ? c.debug.core() : null; } catch (e) { return null; } })() : null]
        .forEach(function (k) { if (k && k.shake) try { k.shake(); } catch (e) { /* never stops the page */ } });
      if (window.JoyaPresence && window.JoyaPresence.note) window.JoyaPresence.note(b.label, ML.VP_SHOW_MS);
    }
    clearTimeout(vpTimer);
    vpTimer = setTimeout(function () { vpShown = null; paintState(); }, ML.VP_SHOW_MS + 20);
    setTimeout(function () { if (vpShown) paintState(); }, ML.VP_MIN_MS + 20); // a state change meanwhile ends it then
    paintState();
  }
  function paintCaption(snap) {
    snap = snap || snapshot();
    var c = ML.caption(snap);
    var cs = $("cc-cap-state");
    var sNow = S.online ? c.state : "offline";
    cs.setAttribute("data-s", sNow);
    // A verdict stays until it times out, the state changes, or the call ends.
    if (vpShown && (Date.now() > vpShown.until || (vpShown.state !== sNow && Date.now() >= vpShown.at + ML.VP_MIN_MS))) vpShown = null;
    var vi = $("cc-cap-vp");
    if (vpShown) {
      cs.setAttribute("data-vp", vpShown.badge.tone);
      if (vi) { vi.hidden = false; vi.setAttribute("data-i", vpShown.badge.icon); }
      $("cc-cap-label").textContent = vpShown.badge.label;
    } else {
      cs.removeAttribute("data-vp");
      if (vi) vi.hidden = true;
      $("cc-cap-label").textContent = c.label;
    }
    var line = $("cc-cap"), sig = c.state + "|" + c.text + "|" + c.interim;
    if (sig !== capSig) {
      capSig = sig;
      line.classList.toggle("interim", !!c.interim);
      if (c.words && !reducedMotion()) {
        // The sentence being spoken: each word fades in at speaking pace.
        line.textContent = "";
        c.text.split(" ").forEach(function (w, i) {
          var sp = document.createElement("span");
          sp.className = "w";
          sp.textContent = w + " ";
          sp.style.animationDelay = Math.round(i * 300) + "ms";
          line.appendChild(sp);
        });
      } else line.textContent = c.text;
    }
    var last = lastReplyTurn();
    var more = $("cc-cap-more");
    more.hidden = !(c.state === "idle" && S.online && last);
    if (last) $("cc-cap-at").textContent = hm(last.ended_at || last.started_at || last.created_at);
    // After a quiet spell the reply line rests; "See last reply" stays in its place.
    if (c.state !== "idle" || sig !== capRestSig) { capQuietSince = Date.now(); capRestSig = sig; }
    var o = { state: c.state, online: S.online, hasReply: !!(last && snap.lastReply), typing: !!$("cc-input").value.trim(),
      voice: !!((typeof Voice !== "undefined" && Voice && Voice.on) || liveActive()), replyOpen: !$("cc-reply").hidden, quietSince: capQuietSince, now: Date.now() };
    var rest = ML.captionRests(o);
    $("cc-caption").classList.toggle("rest", rest);
    line.setAttribute("aria-hidden", rest ? "true" : "false");
    if (!$("cc-cap-more").classList.contains("open")) $("cc-cap-more-t").textContent = rest || !o.hasReply ? "See last reply" : "Full reply";
    clearTimeout(capRestTimer);
    var due = ML.captionRestIn(o);
    if (due != null && !rest) capRestTimer = setTimeout(function () { paintCaption(); }, due + 20);
    return c;
  }
  /** Idle: the composer and its hint row sit translucent until you hover, focus or type, or something happens. */
  var calmState = "idle";
  function paintCalm(st) {
    if (st) calmState = st;
    $("cc-dock").classList.toggle("calm", ML.composerCalm({ online: S.online, state: calmState, text: !!$("cc-input").value.trim(),
      voice: !!(typeof Voice !== "undefined" && Voice && Voice.on), live: liveActive() }));
  }
  document.addEventListener("joya-shell-full", function () { S.liveReplies.clear(); paintState(); });
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function paintState() {
    if (!Voice.speaking) S.spoken = "";
    var snap = snapshot();
    var st = ML.coreState(snap);
    Orb.setState(st);
    if (Orb.setOffline) Orb.setOffline(!S.online && !!S.offlineMsg); // core E: the error face once JOYA AI is known to be unreachable (not while connecting)
    var capNow = paintCaption(snap);
    paintCalm(st);
    if (window.JoyaShell) window.JoyaShell.feed({ state: st, pending: snap.pending, cap: capNow && capNow.text, live: liveActive(), muted: !!(liveActive() && window.VoiceLive && window.VoiceLive.muted && window.VoiceLive.muted()) });
    renderNeed();
    var pending = snap.pending;
    var chip = $("cc-sys"), cdot = $("cc-sys-dot");
    var lng = chip.querySelector(".long"), sht = chip.querySelector(".short");
    function lab(l, s) { lng.textContent = l; sht.textContent = s; }
    chip.className = "cc-sys-chip";
    var proc = S.status && S.status.process;
    var failed = failedServices().length;
    if (!S.online) {
      chip.classList.add("bad"); cdot.className = "cc-dot bad"; lab("JOYA AI offline", "Offline");
    } else if (proc && proc.state !== "ready") {
      chip.classList.add(proc.state === "starting" || proc.state === "stopping" ? "warn" : "bad");
      cdot.className = "cc-dot warn"; lab("JOYA AI " + proc.state, proc.state);
    } else if (failed) {
      chip.classList.add("warn"); cdot.className = "cc-dot warn"; lab(failed + " failed service" + (failed === 1 ? "" : "s"), failed + " issue" + (failed === 1 ? "" : "s"));
    } else if (S.status && S.status.busy) {
      cdot.className = "cc-dot work"; lab("JOYA AI working", "Working");
    } else {
      cdot.className = "cc-dot"; lab("All systems nominal", "Nominal");
    }
    paintSend();
    clearTimeout(stateTimer);
    if (S.delegatingUntil > Date.now()) stateTimer = setTimeout(paintState, S.delegatingUntil - Date.now() + 30);
  }

  /* ================================================================ left rail */

  function renderRail() {
    renderMachine();
    renderCore();
  }

  /** This VPS: vitals and failed services from status.machine (older
      supervisors only send status.vitals, which is used instead). */
  function renderMachine() {
    var st = S.status || {};
    var m = st.machine || {};
    var v = m.vitals || st.vitals || {};
    var host = m.host || v.host || "";
    $("cc-host").textContent = "This VPS";
    var sv = m.services || null;
    var failed = (sv && sv.failed) || [];
    var badge = $("cc-mach-badge");
    if (!S.online && !st.vitals) { badge.className = "cc-badge b-mute"; badge.textContent = "unknown"; }
    else if (failed.length) { badge.className = "cc-badge b-warn"; badge.textContent = failed.length + " failed"; }
    else { badge.className = "cc-badge b-ok"; badge.textContent = "healthy"; }
    var sub = [host || "this box"];
    if (v.uptime_s) sub.push(upDur(v.uptime_s));
    if (v.cpus) sub.push(v.cpus + " vCPU");
    if (v.mem && v.mem.total) sub.push(bytesGB(v.mem.total));
    $("cc-mach-sub").textContent = sub.join(" · ");
    function bar(key, label, val) {
      var el = document.querySelector('[data-mb="' + key + '"]');
      if (!el) return;
      el.firstChild.nodeValue = label + " " + (val == null ? "—" : Math.round(pct(val)) + "%");
      el.classList.toggle("hot", val != null && val > 75);
      el.style.setProperty("--v", (val == null ? 0 : pct(val)) + "%");
    }
    bar("cpu", "CPU", v.cpu_pct);
    bar("ram", "RAM", v.mem && v.mem.pct);
    bar("disk", "DISK", v.disk && v.disk.pct);
    var note = $("cc-mach-note");
    note.className = "cc-mach-note" + (failed.length ? " bad" : "");
    if (failed.length) {
      var f = failed[0];
      note.innerHTML = ic("alert") + "<span>" + esc(String(f.unit || "a service").replace(/\.service$/, "")) + " failed" + (f.since ? " " + esc(hm(f.since)) : "") +
        (failed.length > 1 ? " · +" + (failed.length - 1) + " more" : "") + "</span>";
      note.title = failed.map(function (x) { return x.unit + (x.since ? " since " + hm(x.since) : ""); }).join("\n");
    } else if (sv && sv.total) {
      note.innerHTML = ic("check") + "<span>" + esc(sv.up + " of " + sv.total + " services up") + "</span>";
      note.title = "";
    } else {
      note.innerHTML = ic("clock") + "<span>" + esc(v.load ? "load " + v.load.map(function (x) { return Number(x).toFixed(2); }).join(" · ") : "waiting for vitals") + "</span>";
      note.title = "";
    }
    $("cc-mach-aside").textContent = m.at || sv && sv.at ? "checked " + hm(m.at || sv.at) : "this VPS";
  }

  function setCore(key, val, cls, title) {
    var cell = document.querySelector('[data-cell="' + key + '"]');
    if (!cell) return;
    var b = cell.querySelector("[data-st]");
    b.textContent = val;
    b.className = cls || "";
    cell.title = title || "";
  }

  function renderCore() {
    var st = S.status || {};
    var proc = st.process || {};
    var c = st.counts || {};
    $("cc-core-aside").textContent = proc.model ? modelLabel(proc.model) + (proc.effort ? " · " + proc.effort : "") : "—";
    if (!S.online) setCore("core", "offline", "bad", S.offlineMsg || "supervisor unreachable");
    else setCore("core", proc.state === "ready" ? "online" : proc.state || "—", proc.state === "ready" ? "ok" : "warn", "JOYA AI's own Claude session");

    var live = liveSessions();
    var cnt = { working: 0, waiting: 0, idle: 0 };
    live.forEach(function (s) { cnt[sessState(s)]++; });
    setCore("sessions", live.length + " live", "", cnt.working + " working · " + cnt.waiting + " waiting · " + cnt.idle + " idle");

    var ag = S.agents;
    if (ag && !ag.error && ag.total != null) {
      var down = ag.total - ag.active;
      setCore("agents", down > 0 ? down + " down" : ag.active + " ok", down > 0 ? "warn" : "ok", (ag.channels || []).join(" · "));
    } else setCore("agents", "—", "off", ag === null && S.online ? "not in your role" : "unavailable");

    var mem = S.memory;
    if (mem && !mem.error) setCore("memory", num(mem.facts), mem.healthy ? "" : "warn", num(mem.facts) + " facts · " + num(mem.chunks) + " chunks" + (mem.healthy ? "" : " · degraded"));
    else setCore("memory", "—", "off", "unavailable");

    if (c.watchers_total != null) setCore("watchers", c.watchers_on + " on", c.watchers_on ? "ok" : "off", c.watchers_on + " of " + c.watchers_total + " watchers listening");
    else setCore("watchers", "—", "off", "");
    if (c.rules_user != null || c.rules_builtin != null) setCore("rules", String((c.rules_user || 0) + (c.rules_builtin || 0)), "", (c.rules_user || 0) + " of yours · " + (c.rules_builtin || 0) + " built in");
    else setCore("rules", "—", "off", "");

    setCore("voice", liveActive() ? "live" : READY ? "ready" : "off", liveActive() ? "warn" : READY ? "ok" : "off", READY ? "Live conversation · OpenAI · " + (VOICE || "voice") : "Voice is off (Settings ▸ Voice)");

    var pend = pendingApprovals().length;
    var mins = Math.round((st.approval_timeout_s || 300) / 60);
    setCore("guard", pend ? String(pend) : "on", pend ? "warn" : "ok", "Destructive steps wait for Approve; nobody answering in " + mins + " min means denied.");
  }

  /* ================================================================ sessions */

  var sessSig = "", nodesSig = "";
  /** One live session as the core shows it (cc-map.js / cc-family.js). Real data only. */
  function familyNode(s) {
    var name = s.name || "unnamed session", st = sessState(s), since = Date.now() - 24 * 3600 * 1000;
    var subs = (s.subagents || []).filter(function (a) { return a && a.status !== "done" && a.status !== "failed" && a.status !== "completed"; });
    // What it said last: its latest message to JOYA AI, else the last delegation it got.
    var last = "", lastAt = 0, dels = 0;
    S.inbound.forEach(function (r) { if (ML.resolveFrom(r, S.sessions) === s && Date.parse(r.received_at) > lastAt) { lastAt = Date.parse(r.received_at); last = String(r.text || "").replace(/\[Cross-session [a-z ]+\]/i, "").trim(); } });
    // Today's delegations by who they really went to (session id first), so a restart (new pid) keeps them.
    S.delegations.forEach(function (d) { if (Date.parse(d.created_at) >= since && ML.resolveTarget(d, S.sessions, ALIAS).session === s) dels++; });
    var d = s.last_delegation;
    var task = st === "waiting" ? "Waiting on you" + (s.waiting_for ? " — " + clip(s.waiting_for, 60) : "") :
      s.mission && s.mission.ref ? s.mission.ref + (s.mission.step_n ? " step " + s.mission.step_n : "") + (d && (d.status === "sent" || d.status === "working") ? ": " + clip(d.summary || firstLine(d.text) || "", 70) : "") :
      d && (d.status === "sent" || d.status === "working" || d.status === "ack") ? clip(d.summary || firstLine(d.text) || "", 80) :
      st === "working" ? "Working" : "Nothing running";
    if (!last && d) last = d.summary || firstLine(d.text) || "";
    return {
      id: sessKey(s), label: clip(name, 26), name: name, st: st, subs: subs, mission: s.mission ? s.mission.ref || "mission" : "",
      tok: ML.tokLine(s.tokens_today), tokTip: ML.tokTip(s.tokens_today), task: task, last: clip(last, 140),
      // Size: what it did today (delegations, tokens: 2 per million, at most 20), never less than a little.
      act: 1 + dels * 3 + Math.min(20, ((s.tokens_today && s.tokens_today.total) || 0) / 5e5) + (st === "working" ? 2 : 0),
      hired: s.hired === true,
      slug: s.hire && s.hire.slug ? s.hire.slug : null, // hired through JOYA AI (kept or not): its menu has Keep / Retire
      head: sessHead(s).head, // core E: its role's accessory, or the viewer's pin
      role: sessHead(s).role, // its role (cc-logic BOT_ROLE_RULES): the voice of its chirps (joya-sound.js)
    };
  }
  // A sphere's id: the session id first (it survives a restart), then the pid.
  function sessKey(s) { return String(s.session_id || s.pid || s.name); }
  function sessIcon(s) {
    var w = String(s.where || "");
    if (s.self) return "core";
    if (/Desktop/.test(w)) return "desktop";
    if (/Terminal/.test(w)) return "terminal";
    if (/Remote/.test(w)) return "remote";
    return "sessions";
  }
  function sessWhere(s) {
    var w = String(s.where || s.kind || "");
    return /Desktop/.test(w) ? "Desktop" : /Terminal/.test(w) ? "Terminal" : /Remote/.test(w) ? "Remote" : w ? clip(w, 14) : "session";
  }
  function subagentLabel(a) { return a.description || a.type || ("agent-" + a.id); }
  function sortSessions(list) {
    return list.slice().sort(function (a, b) {
      if (a.self !== b.self) return a.self ? 1 : -1;
      return String(a.started_at || "").localeCompare(String(b.started_at || "")) || (a.pid || 0) - (b.pid || 0);
    });
  }
  function selfState() { return S.status && S.status.busy ? "working" : "idle"; }
  function sessLine(s) {
    var bits = [];
    var n = (s.subagents || []).length;
    if (n) bits.push("<b>" + n + " sub-agent" + (n === 1 ? "" : "s") + "</b>");
    if (s.self) bits.push(S.status && S.status.busy ? "working on a turn" : "CEO · ready");
    else if (s.waiting_for) bits.push("waiting for " + esc(s.waiting_for));
    else {
      var d = s.last_delegation;
      if (d && Date.now() - Date.parse(d.updated_at || d.created_at) < 6 * 3600 * 1000) bits.push(esc((d.status === "ack" ? "replied" : d.status) + " " + ago(d.updated_at || d.created_at)));
      else bits.push(esc(sessState(s) + (s.status_since ? " " + ago(s.status_since) : "")));
    }
    if (s.tokens_today) bits.push('<span title="' + esc(ML.tokTip(s.tokens_today)) + '">' + esc(ML.tokLine(s.tokens_today, "today")) + "</span>");
    return bits.join(" · ");
  }
  function renderSessions(force) {
    var list = sortSessions(S.sessions);
    var sig = JSON.stringify(list.map(function (s) {
      return [s.pid, s.name, s.status, s.waiting_for, s.where, s.open_delegations, s.last_delegation && [s.last_delegation.id, s.last_delegation.status],
        s.mission && [s.mission.ref, s.mission.step_n, s.mission.step_status], s.tokens_today && s.tokens_today.total, s.cwd,
        (s.subagents || []).map(function (a) { return [a.id, a.status, a.description]; })];
    })) + "|" + S.target + "|" + (S.status && S.status.busy) + "|" + (S.status && S.status.process && S.status.process.model) + "|" + coreNow() + JSON.stringify(botTeam);
    var live = liveSessions();
    $("cc-sess-aside").textContent = live.length + " live" + (S.status && S.status.sessions_at ? " · polled " + ago(S.status.sessions_at) : "");
    // Hiring (M-6): how many of the 7 places are taken, and how many of those JOYA AI hired.
    var hc = $("cc-hire-count");
    if (hc) {
      var nHired = live.filter(function (s) { return s.hire; }).length, nLive = S.sessions.filter(function (s) { return !s.self; }).length;
      hc.textContent = nLive + " of 7 in use · " + nHired + " hired";
      hc.className = "cc-tag " + (nLive >= 7 ? "warn" : "mute");
      hc.title = nLive >= 7 ? "No room: JOYA AI cannot hire until a session ends or is retired." : "Sessions live now (JOYA AI itself not counted); hired ones included.";
    }
    // The core's sessions (the orbit's dots or the family of spheres): what each is doing, its last message, today's cost.
    var nodes = sortSessions(live).map(familyNode);
    var nodeSig = JSON.stringify(nodes);
    // The day timeline (cc-story.js) is replaying a past moment: it sets the spheres; live comes back on "Now".
    if (window.JoyaStory && window.JoyaStory.replaying()) nodesSig = "";
    else if (nodeSig !== nodesSig || force) { nodesSig = nodeSig; Orb.setNodes(nodes); }
    if (sig === sessSig && !force) return;
    sessSig = sig;
    Orb.mark(S.target !== "auto" ? (function () { var x = sessionNamed(S.target); return x ? sessKey(x) : null; })() : null);

    var el = $("cc-sessions");
    if (!list.length) {
      el.innerHTML = '<div class="cc-empty-s">' + (S.online ? "No Claude Code sessions are registered on this machine right now." : "Sessions appear here when JOYA AI's supervisor is reachable.") + "</div>";
      return;
    }
    var p = (S.status && S.status.process) || {};
    var self = list.filter(function (s) { return s.self; });
    var others = list.filter(function (s) { return !s.self; });
    var h = "";
    self.forEach(function (s) {
      h += '<div class="cc-sec-t">JOYA AI<span class="sp"></span><span class="cc-tag ai">CEO · you talk to it</span></div>' +
        '<div class="cc-card cc-sc self" data-sess="' + esc(sessKey(s)) + '"><div class="t"><b>JOYA AI</b><span class="sp"></span><span class="cc-mono" title="' + esc(ML.tokTip(s.tokens_today)) + '">' + esc(ML.tokLine(s.tokens_today, "today")) + "</span></div>" +
        '<div class="m">' + esc([p.model ? modelLabel(p.model) + (p.effort ? " · " + p.effort : "") : "", s.cwd || "/root/joya-ai", selfState() === "working" ? "working on a turn" : "routes work to the sessions below"].filter(Boolean).join(" · ")) + "</div>" +
        '<div class="acts"><button type="button" class="cc-btn sm" data-deep-open="' + esc(sessKey(s)) + '">' + ic("eye") + "Deep view</button></div></div>";
    });
    h += '<div class="cc-sec-t">Sessions and their sub-agents</div>';
    if (!others.length) h += '<div class="cc-empty-s">No other sessions are live.</div>';
    others.forEach(function (s) {
      var st = sessState(s), key = sessKey(s), name = s.name || "unnamed session";
      var tag = st === "working" ? '<span class="cc-tag ok">working</span>' : st === "waiting" ? '<span class="cc-tag warn">waiting' + (s.waiting_for ? " on " + esc(clip(s.waiting_for, 24)) : "") + "</span>" : '<span class="cc-tag mute">idle</span>';
      if (s.hire) tag = '<span class="cc-tag ' + (s.hire.kept ? "ok" : "mute") + '" data-hire-tag>' + (s.hire.kept ? "kept" : "hired") + "</span>" + tag;
      if (s.mission) tag = '<span class="cc-tag ai">' + ic("flag") + esc(s.mission.ref || "mission") + (s.mission.step_n ? " · step " + esc(s.mission.step_n) : "") + "</span>" + tag;
      var subs = s.subagents || [];
      h += '<div class="cc-card cc-sc ' + st + (S.target === s.name ? " target" : "") + '" data-sess="' + esc(key) + '" title="' + esc(name + " · " + (s.cwd || "") + " · pid " + (s.pid || "?")) + '">' +
        '<div class="t"><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : "idle") + '"></span><b>' + esc(name) + '</b><span class="sp"></span>' + tag + "</div>" +
        '<div class="m">' + sessLine(s) + " · " + esc(sessWhere(s)) + "</div>" +
        (subs.length ? '<div class="cc-subagents">' + subs.map(function (a) { return "<div><i></i><b>" + esc(a.type || "agent") + "</b> " + esc(clip(a.description || "", 80)) + "</div>"; }).join("") + "</div>" : "") +
        '<div class="acts"><button type="button" class="cc-btn sm" data-deep-open="' + esc(key) + '">' + ic("eye") + "Deep view</button>" +
        (s.name ? '<button type="button" class="cc-btn sm" data-at="' + esc(s.name) + '">' + ic("message") + "Message via JOYA AI</button>" : "") + botPick(s) +
        (s.hire ? '<button type="button" class="cc-btn sm" data-hire-keep="' + esc(key) + '" aria-pressed="' + (s.hire.kept ? "true" : "false") + '">' + (s.hire.kept ? "Stop keeping" : "Keep") + "</button>" +
          '<button type="button" class="cc-btn sm" data-hire-retire="' + esc(key) + '"' + (s.hire.kept ? ' disabled title="Kept: stop keeping it first"' : "") + ">Retire…</button>" : "") + "</div></div>";
    });
    el.innerHTML = h;
  }
  function findSess(key) {
    for (var i = 0; i < S.sessions.length; i++) if (sessKey(S.sessions[i]) === key) return S.sessions[i];
    return null;
  }
  function highlightSess(key) {
    var el = document.querySelector('[data-sess="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (!el) return;
    el.classList.add("hl");
    setTimeout(function () { el.classList.remove("hl"); }, 2400);
  }

  $("cc-sessions").addEventListener("change", function (e) {
    var sel = e.target.closest && e.target.closest("[data-bot-sess]");
    if (sel) setSessHead(sel.getAttribute("data-bot-sess"), sel.value || null);
  });
  $("cc-sessions").addEventListener("click", function (e) {
    var d = e.target.closest("[data-deep-open]");
    if (d) { P.openDeep(d.getAttribute("data-deep-open")); return; }
    var at = e.target.closest("[data-at]");
    if (at) { setTarget(at.getAttribute("data-at")); closeSheet(); input.focus(); return; }
    var kb = e.target.closest("[data-hire-keep]");
    if (kb) { var ks = findSess(kb.getAttribute("data-hire-keep")); if (ks && ks.hire) hireKeep(ks, !ks.hire.kept); return; }
    var rb = e.target.closest("[data-hire-retire]");
    if (rb && !rb.disabled) { var rs = findSess(rb.getAttribute("data-hire-retire")); if (rs && rs.hire) retireDialog(rs); }
  });

  /* ---- hired sessions (M-6): the administrator keeps one, or retires it.
     Right-click a sphere (or the context-menu key on its name) for its menu;
     the sessions sheet has the same two buttons. Retire always goes through
     the Keep / Retire consent dialog; the supervisor refuses a kept session,
     and any session JOYA AI did not hire. */
  function closeSessMenu() {
    var m = document.querySelector(".cc-smenu");
    if (m) m.remove();
    document.removeEventListener("pointerdown", sessMenuAway, true);
  }
  function sessMenuAway(e) { if (!e.target.closest || !e.target.closest(".cc-smenu")) closeSessMenu(); }
  function sessMenu(key, x, y) {
    closeSessMenu();
    var s = findSess(key);
    if (!s) return;
    var m = document.createElement("div");
    m.className = "cc-smenu";
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", (s.name || "session") + " menu");
    var h = '<div class="h">' + esc(clip(s.name || "unnamed session", 32)) + (s.hire ? ' <span class="cc-ktag' + (s.hire.kept ? " kept" : "") + '">' + (s.hire.kept ? "Kept" : "Hired") + "</span>" : "") + "</div>" +
      '<button type="button" role="menuitem" data-sm="open">' + ic("eye") + "Open the conversation</button>";
    if (s.hire) {
      h += '<button type="button" role="menuitem" data-sm="keep">' + ic("check") + (s.hire.kept ? "Stop keeping it" : "Keep it (never retired by JOYA AI)") + "</button>" +
        '<button type="button" role="menuitem" data-sm="retire" class="danger"' + (s.hire.kept ? ' aria-disabled="true"' : "") + ">" + ic("stop") + "Retire…</button>" +
        (s.hire.kept ? "<small>Kept: stop keeping it before retiring it.</small>" : "<small>JOYA AI hired it" + (s.hire.purpose ? ": " + esc(clip(s.hire.purpose, 90)) : "") + "</small>");
    } else {
      h += "<small>Your own session: never retired from here or by JOYA AI.</small>";
    }
    m.innerHTML = h;
    document.body.appendChild(m);
    var w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - hh - 8)) + "px";
    m.addEventListener("click", function (e) {
      var b = e.target.closest("[data-sm]");
      if (!b || b.getAttribute("aria-disabled") === "true") return;
      var what = b.getAttribute("data-sm");
      closeSessMenu();
      if (what === "open") { if (P && P.openDeep) P.openDeep(key); else { openSheet("sessions"); highlightSess(key); } }
      else if (what === "keep") hireKeep(s, !s.hire.kept);
      else if (what === "retire") retireDialog(s);
    });
    m.addEventListener("keydown", function (e) {
      var items = [].slice.call(m.querySelectorAll("[data-sm]")), i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { closeSessMenu(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
    });
    setTimeout(function () { document.addEventListener("pointerdown", sessMenuAway, true); }, 0);
    var first = m.querySelector("[data-sm]");
    if (first) first.focus();
  }
  function hireKeep(s, kept) {
    api("sessions/" + encodeURIComponent(s.hire.slug) + "/keep", { body: { kept: kept } }).then(function () {
      s.hire.kept = kept; s.hired = !kept;
      renderSessions(true);
      toast(kept ? "Kept “" + s.name + "”: JOYA AI can never retire it." : "“" + s.name + "” is no longer kept.");
    }, function (e) { toast(e.message, true); });
  }
  function retireDialog(s) {
    if (document.querySelector(".cc-sdlg-back")) return;
    var back = document.createElement("div");
    back.className = "cc-sdlg-back";
    back.innerHTML = '<div class="cc-sdlg" role="alertdialog" aria-modal="true" aria-labelledby="cc-sdlg-t">' +
      '<h3 id="cc-sdlg-t">Retire “' + esc(s.name) + '”?</h3>' +
      "<p>It ends gracefully and its sphere dissolves; its transcript is kept.</p>" +
      (s.hire && s.hire.purpose ? '<p class="purpose">JOYA AI hired it: ' + esc(clip(s.hire.purpose, 200)) + "</p>" : "") +
      '<div class="err" data-sdlg-err hidden></div>' +
      '<div class="acts"><button type="button" class="cc-btn" data-sdlg="keep">Keep</button><button type="button" class="cc-btn danger" data-sdlg="retire">Retire</button></div></div>';
    document.body.appendChild(back);
    var prev = document.activeElement;
    function close() { back.remove(); if (prev && prev.focus) prev.focus(); }
    back.addEventListener("click", function (e) {
      if (e.target === back) return close();
      var b = e.target.closest("[data-sdlg]");
      if (!b) return;
      if (b.getAttribute("data-sdlg") === "keep") return close();
      b.disabled = true;
      api("sessions/" + encodeURIComponent(s.hire.slug) + "/retire", { body: {} }).then(function () {
        close();
        toast("Retired “" + s.name + "”. Its transcript is kept.");
      }, function (err) {
        b.disabled = false;
        var el = back.querySelector("[data-sdlg-err]");
        el.textContent = err.message; el.hidden = false;
      });
    });
    back.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      if (e.key === "Tab") { var bs = back.querySelectorAll("button"); if (e.shiftKey && document.activeElement === bs[0]) { e.preventDefault(); bs[bs.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === bs[bs.length - 1]) { e.preventDefault(); bs[0].focus(); } }
    });
    back.querySelector('[data-sdlg="keep"]').focus();
  }

  /** The Remote Control link, fetched when asked for and never kept on the page. */
  function openRemoteControl() {
    var w = window.open("about:blank", "_blank");
    api("rc").then(function (rc) {
      var url = rc && rc.url;
      if (!rc.enabled || !url || !/^https:\/\/claude\.ai\//.test(url)) {
        if (w) w.close();
        toast(rc && rc.enabled ? "Remote Control has no session link yet." : "Remote Control is off for JOYA AI.", true);
        return;
      }
      if (w) { w.opener = null; w.location.replace(url); }
      else toast("The browser blocked the new tab; allow pop-ups for this panel.", true);
    }).catch(function (e) {
      if (w) w.close();
      toast("Could not read the Remote Control link: " + e.message, true);
    });
  }
  $("cc-rc-open").addEventListener("click", openRemoteControl);

  /** Interrupt JOYA AI's current turn. */
  function interrupt(btn) {
    if (btn) btn.disabled = true;
    return api("interrupt", { body: {} }).then(function () { toast("Interrupting the current turn…"); })
      .catch(function (e) { toast("Could not interrupt: " + e.message, true); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ================================================================ composer */

  var input = $("cc-input");
  function setTarget(name) {
    S.target = name && name !== "auto" ? name : "auto";
    var set = S.target !== "auto";
    $("cc-target-label").textContent = set ? "→ " + clip(S.target, 26) : "Auto-route";
    $("cc-vb-target").textContent = set ? "→ " + clip(S.target, 22) : "Auto-route";
    $("cc-target").classList.toggle("set", set);
    $("cc-target").title = set ? "Addressed to " + S.target + " (JOYA AI delegates it there): click to change" : "Address a session (@): JOYA AI picks one now";
    $("cc-target").setAttribute("aria-label", set ? "Addressed to " + S.target + ": change" : "Address a session: JOYA AI picks");
    input.placeholder = set ? "Tell " + clip(S.target, 30) + " what to do (through JOYA AI)" : "Ask JOYA AI";
    renderSessions(true);
  }

  var menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; $("cc-target").setAttribute("aria-expanded", "false"); }
  }
  function openMenu() {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "cc-target-menu";
    menu.setAttribute("role", "menu");
    var h = '<button type="button" role="menuitemradio" aria-checked="' + (S.target === "auto") + '" data-t="auto" class="' + (S.target === "auto" ? "on" : "") + '">' + ic("route") + '<span class="nm">Auto-route</span><small>JOYA AI decides</small></button><hr>';
    var live = sortSessions(liveSessions());
    if (!live.length) h += '<button type="button" disabled><span class="nm">No other sessions are live</span></button>';
    live.forEach(function (s) {
      var st = sessState(s);
      h += '<button type="button" role="menuitemradio" aria-checked="' + (S.target === s.name) + '" data-t="' + esc(s.name || "") + '" class="' + (S.target === s.name ? "on" : "") + '"' + (s.name ? "" : " disabled") + '><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : "idle") + '"></span><span class="nm">' + esc(s.name || "unnamed") + "</span><small>" + esc(String(s.where || "").replace(" · Remote Control", " · RC")) + "</small></button>";
    });
    menu.innerHTML = h;
    // In the field (the @ button shows only once a session is chosen), above the bar.
    $("cc-compose").appendChild(menu);
    $("cc-target").setAttribute("aria-expanded", "true");
    menu.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var b = ev.target.closest("button[data-t]");
      if (!b || b.disabled) return;
      setTarget(b.getAttribute("data-t"));
      closeMenu();
      input.focus();
    });
    menu.addEventListener("keydown", function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll("button[data-t]:not([disabled])"));
      var i = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); (items[i + 1] || items[0]).focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      // Enter picks the highlighted session (the button's own click); it never reaches the message box.
      if (ev.key === "Enter") ev.stopPropagation();
      if (ev.key === "Escape") { closeMenu(); input.focus(); }
    });
    var on = menu.querySelector("button.on") || menu.querySelector("button[data-t]");
    if (on) on.focus();
  }
  $("cc-target").addEventListener("click", function (e) {
    if (menu && menu.contains(e.target)) return;
    e.stopPropagation();
    if (menu) closeMenu(); else openMenu();
  });
  document.addEventListener("click", function (e) { if (menu && !$("cc-target").contains(e.target) && !menu.contains(e.target)) closeMenu(); });

  /* The message box: a text area that grows with what is typed (up to about six lines, then it
     scrolls inside) and shrinks back after a send. Enter sends; Shift+Enter is a new line; Enter while
     an input method is composing (Arabic, Japanese…) belongs to the input method. */
  // One line, the field sits between "+" and the buttons; once the text wraps or has a new line, it takes
  // the whole width above them (as ChatGPT's does) and stays that way until it is emptied.
  function fitInput() {
    var form = $("cc-compose");
    if (!input.value) form.classList.remove("multi");
    else if (!form.classList.contains("multi")) {
      input.style.height = "auto";
      if (/\n/.test(input.value) || input.scrollHeight > input.clientHeight + 2) form.classList.add("multi");
    }
    input.style.height = "auto";
    var max = parseFloat(getComputedStyle(input).maxHeight) || 168;
    var h = Math.min(input.scrollHeight, max);
    input.style.height = h + "px";
    input.classList.toggle("scrolls", input.scrollHeight > max + 1);
  }
  function composerReady() { return !!$("cc-input").value.trim() || ((S.att || []).some(function (a) { return a.state === "done"; })); }
  /* The round button at the right: send (filled when there is something to send, greyed when not); while
     JOYA AI works and nothing is typed, it is the stop square instead (a typed message still sends: it queues). */
  function paintSend() {
    var up = (S.att || []).some(function (a) { return a.state === "queued" || a.state === "up"; });
    var ready = composerReady(), busy = !!(S.status && S.status.busy);
    // One round button at the end of the bar: stop while JOYA AI works and nothing is typed; send once there
    // is text or a file; otherwise the live conversation (the waveform; struck through when voice is off).
    var stop = busy && !ready, mic = $("cc-c-mic") || document.querySelector(".cc-composer .cc-c-mic.off");
    $("cc-stop").hidden = !stop;
    $("cc-send").hidden = stop || !ready;
    if (mic) mic.hidden = stop || ready;
    if (!mic) $("cc-send").hidden = stop;
    $("cc-send").classList.toggle("ready", ready && !up);
    $("cc-send").setAttribute("aria-disabled", ready && !up ? "false" : "true");
    $("cc-send").title = up ? "Waiting for the files to finish uploading" : ready ? "Send (Enter)" : "Type a message or attach a file to send";
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "@" && !input.value) { e.preventDefault(); openMenu(); return; }
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    var f = $("cc-compose");
    if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { cancelable: true }));
  });
  // "@planning-engine do this": a session named at the start addresses the message to it.
  input.addEventListener("focus", capActivity);
  input.addEventListener("blur", capActivity);
  input.addEventListener("input", function () {
    capActivity();
    paintCalm();
    fitInput();
    paintSend();
    if (Orb.poke) Orb.poke(); // core E: typing wakes a dozing bot
    var m = /^@(\S+)\s/.exec(input.value);
    if (!m) return;
    var q = m[1].toLowerCase(), hit = null;
    liveSessions().forEach(function (s) { if (!hit && s.name && s.name.toLowerCase().indexOf(q) === 0) hit = s; });
    if (hit) { setTarget(hit.name); input.value = input.value.slice(m[0].length); fitInput(); }
  });
  window.addEventListener("resize", function () { if (input.value) fitInput(); });

  function hint(text, bad) {
    var h = $("cc-hint");
    if (!h.getAttribute("data-default")) h.setAttribute("data-default", h.innerHTML);
    if (!text) { h.innerHTML = h.getAttribute("data-default"); h.classList.remove("err"); return; }
    h.textContent = text;
    h.classList.toggle("err", !!bad);
  }

  /* ---------------------------------------------------------- attachments
     Files go with a message three ways: the paperclip (a file picker), a paste (files or a screenshot
     on the clipboard) and a drop onto the composer or anywhere on the Command Center. Each is
     uploaded at once (POST /joya-ai/api/uploads, lib/routes-uploads.js) into one folder for the
     message, shown as a chip (a small preview for an image) with its size and a remove button, and
     sent as ids with the message; the server adds a line per file to the turn, which JOYA AI opens
     with its Read tool. Progress and errors are said in words (#cc-att-live) and on the chip; a
     failed upload never touches what was typed. */
  S.att = [];
  S.attBatch = "";
  var attSeq = 0, attQueue = Promise.resolve();
  function attDone() { return S.att.filter(function (a) { return a.state === "done"; }); }
  function attBusy() { return S.att.some(function (a) { return a.state === "queued" || a.state === "up"; }); }
  function announce(text) {
    var l = $("cc-att-live");
    l.textContent = "";
    setTimeout(function () { l.textContent = text; }, 30);
  }
  function renderAtt() {
    var box = $("cc-att");
    box.hidden = !S.att.length;
    $("cc-compose").classList.toggle("has-att", S.att.length > 0);
    var keep = {};
    S.att.forEach(function (a) {
      keep[a.key] = true;
      var el = box.querySelector('[data-att="' + a.key + '"]');
      if (!el) {
        el = document.createElement("div");
        el.setAttribute("role", "listitem");
        el.setAttribute("data-att", a.key);
        el.innerHTML = '<span class="th" aria-hidden="true"></span><span class="tx"><b class="nm"></b><span class="st"></span></span>' +
          '<button type="button" class="x">' + ic("close") + "</button>";
        el.querySelector(".nm").textContent = a.name;
        el.querySelector(".nm").title = a.name;
        box.appendChild(el);
      }
      el.className = "cc-chip " + a.state + (a.image ? " img" : "");
      var th = el.querySelector(".th");
      if (a.image && a.url && !th.querySelector("img")) th.innerHTML = '<img alt="" src="' + esc(a.url) + '">';
      else if (!th.firstChild || (!a.image && !th.querySelector("svg"))) th.innerHTML = ic(a.image ? "image" : "file");
      var st = a.state === "up" ? "Uploading… " + (a.pct || 0) + "%" : a.state === "queued" ? "Waiting to upload" : a.state === "err" ? "Not attached: " + a.err : ML.attachSize(a.size);
      el.querySelector(".st").textContent = st;
      var x = el.querySelector(".x");
      x.setAttribute("aria-label", (a.state === "err" ? "Dismiss " : a.state === "up" || a.state === "queued" ? "Cancel " : "Remove ") + a.name);
      x.title = a.state === "err" ? "Dismiss" : a.state === "up" || a.state === "queued" ? "Cancel the upload" : "Remove";
    });
    Array.prototype.slice.call(box.children).forEach(function (el) { if (!keep[el.getAttribute("data-att")]) el.remove(); });
    paintSend();
    paintCalm();
  }
  function uploadOne(a) {
    return new Promise(function (resolve) {
      if (a.state !== "queued") return resolve();
      a.state = "up";
      a.pct = 0;
      renderAtt();
      var x = new XMLHttpRequest();
      a.xhr = x;
      x.open("POST", "/joya-ai/api/uploads");
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.setRequestHeader("X-CSRF-Token", CSRF);
      x.setRequestHeader("X-File-Name", encodeURIComponent(a.name));
      if (S.attBatch) x.setRequestHeader("X-Upload-Batch", S.attBatch);
      x.setRequestHeader("Accept", "application/json");
      var lastPaint = 0;
      x.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        a.pct = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
        if (Date.now() - lastPaint > 120) { lastPaint = Date.now(); renderAtt(); }
      };
      x.onload = function () {
        var j = {};
        try { j = JSON.parse(x.responseText || "{}"); } catch (e) { j = {}; }
        a.xhr = null;
        if (a.state !== "up") return resolve(); // removed while uploading
        if (x.status >= 200 && x.status < 300 && j.id) {
          a.state = "done"; a.id = j.id; a.url = j.url; a.size = j.size; a.image = !!j.image;
          if (j.batch) S.attBatch = j.batch;
          announce(a.name + " attached.");
        } else {
          a.state = "err";
          a.err = x.status === 401 || x.status === 403 && !j.error ? "you are signed out; reload the page" : (j.error || "the upload failed (" + x.status + ")").replace(/\.$/, "");
          announce(a.name + " could not be attached: " + a.err + ".");
        }
        renderAtt();
        resolve();
      };
      x.onerror = x.ontimeout = function () {
        a.xhr = null;
        if (a.state === "up") { a.state = "err"; a.err = "the connection dropped; try again"; announce(a.name + " could not be attached: " + a.err + "."); renderAtt(); }
        resolve();
      };
      x.send(a.file);
    });
  }
  /** Attach files (a FileList or an array of File). how: "picked" | "pasted" | "dropped". */
  function addFiles(list, how) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) { return f && typeof f.size === "number"; });
    if (!files.length) return 0;
    if (liveActive()) { toast("End the live conversation to attach files.", true); return 0; }
    var took = 0, refused = [];
    files.forEach(function (f) {
      var name = how === "pasted" ? ML.pastedName(f.name, f.type) : f.name || ML.pastedName("", f.type);
      var why = ML.attachRefusal({ name: name, size: f.size, have: S.att.filter(function (a) { return a.state !== "err"; }).length });
      if (why) { refused.push(name + ": " + why); return; }
      var a = { key: "a" + ++attSeq, file: f, name: name, size: f.size, image: /^image\/(png|jpeg|gif|webp)$/.test(f.type || ""), state: "queued" };
      S.att.push(a);
      took++;
      attQueue = attQueue.then(function () { return uploadOne(a); });
    });
    renderAtt();
    if (took) announce((took === 1 ? "Uploading 1 file" : "Uploading " + took + " files") + (refused.length ? ". Not attached: " + refused.join("; ") + "." : "."));
    else if (refused.length) announce("Not attached: " + refused.join("; ") + ".");
    if (refused.length) hint("Not attached: " + refused.join("; "), true);
    return took;
  }
  $("cc-att").addEventListener("click", function (e) {
    var x = e.target.closest ? e.target.closest(".x") : null;
    if (!x) return;
    var key = x.closest("[data-att]").getAttribute("data-att");
    var i = -1;
    S.att.forEach(function (a, k) { if (a.key === key) i = k; });
    if (i < 0) return;
    var a = S.att[i];
    if (a.xhr) { try { a.xhr.abort(); } catch (er) { /* gone */ } }
    a.state = "gone";
    S.att.splice(i, 1);
    // Focus goes to the next chip's button, else the message box: never lost.
    var next = S.att[i] || S.att[i - 1];
    renderAtt();
    announce(a.name + " removed.");
    var nb = next && $("cc-att").querySelector('[data-att="' + next.key + '"] .x');
    (nb || input).focus();
  });
  // The "+": a small menu, Upload a file / Upload a photo (on a phone the photo picker offers the camera too).
  function openAttachMenu() {
    var p = $("cc-pop");
    closePop();
    var off = root.getAttribute("data-voice-off") || "", manage = root.getAttribute("data-voice-manage") === "1";
    p.innerHTML = '<button type="button" role="menuitem" data-attach="file">' + ic("clip") + "Upload a file<small>PDF, Office, text, ZIP</small></button>" +
      '<button type="button" role="menuitem" data-attach="photo">' + ic("image") + "Upload a photo<small>PNG, JPEG, GIF, WebP</small></button>" +
      '<button type="button" role="menuitem" data-attach="session">' + ic("at") + "Address a session<small>" + esc(S.target !== "auto" ? "→ " + clip(S.target, 18) : "or type @") + "</small></button>" +
      (off && manage && /Settings/.test(off) ? '<div class="line">' + ic("info") + "<span>Voice is off.</span><a href=\"/joya-ai/settings/voice\">Settings ▸ Voice</a></div>" : "") +
      '<div class="line ft">' + ic("info") + "<span>Paste or drop files too · up to " + ML.ATTACH_MAX_FILES + " per message, 20 MB each · Shift+Enter new line · Ctrl K everything</span></div>";
    p.setAttribute("data-kind", "attach");
    p.hidden = false;
    $("cc-attach").setAttribute("aria-expanded", "true");
    var r = $("cc-attach").getBoundingClientRect(), pr = p.getBoundingClientRect();
    p.style.left = Math.min(window.innerWidth - pr.width - 12, Math.max(12, r.left)) + "px";
    p.style.top = Math.max(12, r.top - pr.height - 8) + "px";
    var first = p.querySelector("[data-attach]");
    if (first) first.focus();
  }
  $("cc-attach").addEventListener("click", function (e) {
    e.stopPropagation();
    if (!$("cc-pop").hidden && $("cc-pop").getAttribute("data-kind") === "attach") closePop(); else openAttachMenu();
  });
  $("cc-pop").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-attach]") : null;
    if (!b) return;
    e.stopPropagation();
    closePop();
    var k = b.getAttribute("data-attach");
    if (k === "session") return openMenu();
    $(k === "photo" ? "cc-photo" : "cc-file").click();
  });
  $("cc-pop").addEventListener("keydown", function (e) {
    if ($("cc-pop").getAttribute("data-kind") !== "attach") return;
    var items = Array.prototype.slice.call($("cc-pop").querySelectorAll("[data-attach]"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    if (e.key === "Escape") { e.stopPropagation(); closePop(); $("cc-attach").focus(); }
  });
  ["cc-file", "cc-photo"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      addFiles(this.files, "picked");
      this.value = "";
      input.focus();
    });
  });
  // Paste: files or an image on the clipboard are attached; text pastes as text (a copy from an
  // office app carries both: then it is the text that was meant).
  function pastedFiles(e) {
    var cd = e.clipboardData;
    if (!cd) return [];
    var text = cd.getData && cd.getData("text/plain");
    if (text && text.trim()) return [];
    var out = [];
    if (cd.files && cd.files.length) out = Array.prototype.slice.call(cd.files);
    else if (cd.items) for (var k = 0; k < cd.items.length; k++) if (cd.items[k].kind === "file") { var f = cd.items[k].getAsFile(); if (f) out.push(f); }
    return out;
  }
  input.addEventListener("paste", function (e) {
    var files = pastedFiles(e);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files, "pasted");
  });
  document.addEventListener("paste", function (e) {
    if (e.target === input || (e.target && e.target.closest && e.target.closest("input, textarea, [contenteditable], .cc-sheet, .cc-need, #cc-overlay"))) return;
    var files = pastedFiles(e);
    if (!files.length) return;
    e.preventDefault();
    if (addFiles(files, "pasted")) input.focus();
  });
  // Drop: anywhere on the Command Center (the composer lights up as the place they go).
  var dragDepth = 0;
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, "Files") >= 0; }
  function dragOn(on) { $("cc-compose").classList.toggle("dragging", on); $("cc-dock").classList.toggle("dragging", on); }
  document.addEventListener("dragenter", function (e) { if (!hasFiles(e) || liveActive()) return; dragDepth++; dragOn(true); });
  document.addEventListener("dragover", function (e) { if (!hasFiles(e) || liveActive()) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dragOn(true); });
  document.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragOn(false); });
  document.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragOn(false);
    if (addFiles(e.dataTransfer.files, "dropped")) input.focus();
  });
  window.addEventListener("blur", function () { dragDepth = 0; dragOn(false); });

  var voiceTurns = new Set();    // turns whose reply is read aloud
  var sending = false;
  function send(text, opts) {
    opts = opts || {};
    text = String(text || "").trim();
    var files = opts.voice ? [] : attDone();
    if ((!text && !files.length) || sending) return Promise.resolve(null);
    if (!opts.voice && attBusy()) { hint("Wait for the files to finish uploading, then send.", true); announce("Still uploading. Send again when the files are attached."); return Promise.resolve(null); }
    if (S.target !== "auto" && !liveSessions().some(function (s) { return s.name === S.target; })) {
      toast("“" + S.target + "” is no longer running. Sending with auto-route instead.", true);
      setTarget("auto");
    }
    sending = true;
    if (opts.voice) Voice.unlock();
    $("cc-send").disabled = true;
    var body = { text: text, tab: TAB_ID };
    if (S.target !== "auto") body.target = S.target;
    if (files.length) body.attachments = files.map(function (a) { return a.id; });
    // A voice turn names its voice-turn id: the server sends it to JOYA AI
    // only if it is exactly what the server heard for that id.
    if (opts.voice && opts.vt) body.vt = opts.vt;
    return api("send", { body: body }).then(function (r) {
      hint("");
      if (!opts.voice) {
        input.value = "";
        fitInput();
        if (files.length) {
          // What was sent leaves the composer; anything that failed stays to be dismissed.
          var sent = {};
          files.forEach(function (a) { sent[a.key] = true; });
          S.att = S.att.filter(function (a) { return !sent[a.key]; });
          if (!S.att.some(function (a) { return a.state !== "err"; })) S.attBatch = "";
          renderAtt();
          announce("Sent with " + files.length + (files.length === 1 ? " file." : " files."));
        }
      }
      // "yes" / "no" to a pending Tier-2 confirm: answered on the server, sent nowhere.
      if (r && r.confirm && typeof uiConfirmAnswer === "function") uiConfirmAnswer(r.confirm.id, r.confirm.ok);
      if (r && r.turn) {
        var tr = upsertTurn(r.turn);
        if (opts.voice) {
          Voice.tag(r.turn.id, { vt: opts.vt || "t" + r.turn.id, cat: "direct" });
          // The turn may already be over by the time this reply lands: read it now.
          if (tr && tr.ended_at && aiText(tr)) Voice.flush(tr.id, aiText(tr));
          else voiceTurns.add(r.turn.id);
        }
        if (opts.voice && r.queued_behind) Voice.say("Got it. I'll pick that up as soon as I'm free.");
        else if (opts.voice && !opts.acked) Voice.say("On it.");
      }
      paintSend();
      paintState();
      return r;
    }).catch(function (e) {
      // The typed message and the attached files stay where they are, to send again.
      hint("Not sent: " + e.message, true);
      if (!opts.voice) announce("Not sent: " + e.message);
      if (opts.voice) Voice.say("Sorry, that did not go through.");
      return null;
    }).then(function (r) {
      sending = false;
      $("cc-send").disabled = false;
      return r;
    });
  }
  $("cc-compose").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!composerReady()) { input.focus(); return; }
    // "Tell me when ..." may be a watcher: proactive JOYA AI asks first (public/joya-proactive.js).
    if (!attDone().length && window.JoyaProactive && window.JoyaProactive.intercept && window.JoyaProactive.intercept(input.value)) return;
    send(input.value);
  });
  paintSend();
  $("cc-stop").addEventListener("click", function () { interrupt($("cc-stop")); });

  /* ================================================================ sheets
     The dock's sheets slide in from the right (a bottom sheet on a phone).
     Only one is open at a time; each keeps its own content live while closed,
     so opening one is instant. S.pane names the open one. */

  var SHEET_KEYS = ML.sheetKeys().concat(["everything"]);
  function openSheet(id, toggle) {
    // Standing orders became the Schedules tab of Rules & alerts (2026-10-25): its old key still opens it.
    if (id === "orders") { if (P.setRulesSub) P.setRulesSub("orders"); id = "rules"; toggle = false; }
    if (SHEET_KEYS.indexOf(id) < 0) return;
    if (toggle && S.pane === id) return closeSheet();
    closePop();
    closeReply();
    S.pane = id;
    SHEET_KEYS.forEach(function (k) { var p = $("cc-pane-" + k); if (p) p.hidden = k !== id; });
    $("cc-sheet").classList.add("open");
    $("cc-scrim").hidden = false;
    var bs = document.querySelectorAll("#cc-rail [data-sheet]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-expanded", String(bs[i].getAttribute("data-sheet") === id));
    if (id === "conv") { renderSteps(); requestAnimationFrame(function () { toBottom(true); }); }
    if (id === "rules") P.renderRules();
    if (id === "dec") P.renderDecisions();
    if (id === "missions") P.renderMissions();
    if (id === "sessions") renderSessions(true);
    // Focus moves into the sheet (for Escape, Tab and screen readers) without a ring on the close button.
    if (!$("cc-sheet").contains(document.activeElement)) $("cc-pane-" + id).focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!S.pane) return;
    S.pane = null;
    $("cc-sheet").classList.remove("open", "wide");
    $("cc-scrim").hidden = true;
    var bs = document.querySelectorAll("#cc-rail [data-sheet]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-expanded", "false");
  }
  /** The v3 name for the drawer's tabs; everything that called it opens the sheet now. */
  function showPane(id) { openSheet(id); }
  /* A deep link (/joya-ai#dec -- the page map's sheets, the top bar's "needs you") opens that sheet. */
  function sheetFromHash() {
    var k = (location.hash || "").slice(1);
    if ((SHEET_KEYS.indexOf(k) >= 0 && k !== "everything") || k === "orders") openSheet(k);
  }
  window.addEventListener("hashchange", sheetFromHash);
  window.addEventListener("load", sheetFromHash);
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-sheet]");
    if (b) { openSheet(b.getAttribute("data-sheet"), !!b.closest("#cc-rail")); return; }
    if (e.target.closest("[data-sheet-close]") || e.target.id === "cc-scrim") { closeSheet(); return; }
    if (e.target.closest("[data-open-palette]")) { closeSheet(); P.openPalette(); return; }
    var th = e.target.closest("[data-theme-to]");
    if (th) { var tb = document.querySelector('.topbar [data-theme-opt="' + th.getAttribute("data-theme-to") + '"]'); if (tb) tb.click(); }
  });
  $("cc-more").addEventListener("click", function () { openSheet("everything", true); });
  $("cc-expand").addEventListener("click", function () { $("cc-sheet").classList.toggle("wide"); });

  var scroller = $("cc-chat-scroll");
  function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60; }
  function toBottom(force) { if (force || atBottom()) scroller.scrollTop = scroller.scrollHeight; }

  /* ---------------------------------------------------------- conversation
     One block per turn: what came in (you, Remote Control, a peer session, a
     standing order, a watcher), then JOYA AI's bubble -- its text as it
     streams, the delegations the turn made and any approval it is waiting on.
     A standing order's turn is a briefing card instead. */

  var chat = $("cc-chat");
  var TURN_SRC = {
    dashboard: "You", "voice-desk": "You · by voice", remote: "You · Remote Control", peer: "Message from a session",
    idle: "Idle notice", delivery: "Delivery notice", system: "System", unknown: "Turn",
    watcher: "Watcher", order: "Standing order", "mission-request": "New mission", decision: "Decision",
  };

  function upsertTurn(row) {
    if (!row || !row.id) return null;
    var cur = S.turns.get(row.id);
    if (!cur) {
      cur = { id: row.id, blocks: [], partial: "", el: null };
      S.turns.set(row.id, cur);
      S.turnOrder.push(row.id);
      S.turnOrder.sort(function (a, b) { return a - b; });
    }
    // A snapshot taken before the turn ended (the reply to POST send, when the
    // turn was quick) must not put a finished turn back to queued or running.
    var stale = cur.ended_at && !row.ended_at, wasSt = cur.status;
    if (!stale) for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) cur[k] = row[k];
    if (wasSt && wasSt !== cur.status && cur.status === "error") sound("error", "core"); // a turn ended with an error
    if (S.oldestTurn == null || row.id < S.oldestTurn) S.oldestTurn = row.id;
    renderTurn(cur);
    return cur;
  }

  function turnEl(tr) {
    if (tr.el && tr.el.isConnected) return tr.el;
    var el = document.createElement("div");
    el.className = "cc-turn";
    el.setAttribute("data-turn", tr.id);
    // Keep the chat in id order: find the first later turn already on screen.
    var after = null;
    var nodes = chat.querySelectorAll(".cc-turn");
    for (var i = 0; i < nodes.length; i++) if (Number(nodes[i].getAttribute("data-turn")) > tr.id) { after = nodes[i]; break; }
    var empty = chat.querySelector(".cc-chat-empty");
    if (empty) empty.remove();
    chat.insertBefore(el, after || chat.querySelector(".cc-orphans"));
    tr.el = el;
    return el;
  }

  function aiText(tr) {
    var txt = tr.blocks.join("\n\n");
    if (tr.partial) txt += (txt ? "\n\n" : "") + tr.partial;
    if (!txt && tr.result_text) txt = tr.result_text;
    return txt;
  }

  var ORDER_RE = /^\s*\[Standing order: ([^\]\n]{1,120})\]/;
  function isOrderTurn(tr) { return tr.source === "order" || !!tr.order_id; }
  function orderName(tr) {
    var m = ORDER_RE.exec(String(tr.text || ""));
    if (m) return m[1];
    var o = tr.order_id && P.orderById(tr.order_id);
    return o ? o.name : "Standing order";
  }

  function inboundHTML(tr) {
    var who = TURN_SRC[tr.source] || "Turn";
    var when = hm(tr.created_at);
    var text = tr.text || "";
    if (isOrderTurn(tr)) return "";
    if (tr.source === "dashboard" || tr.source === "voice-desk" || tr.source === "remote" || tr.source === "mission-request") {
      var name = tr.source === "remote" ? "You · via Remote Control" : tr.source === "voice-desk" ? (tr.actor && tr.actor !== VIEWER ? esc(tr.actor) : "You") + " · by voice" : tr.actor && tr.actor !== VIEWER ? esc(tr.actor) : "You";
      var tag = tr.source === "mission-request" ? ' · <span class="cc-badge b-mis">' + ic("flag") + "new mission</span>" : "";
      var sa = ML.splitAttached(text);
      return '<div class="cc-msg me"><div class="who"><b>' + name + "</b> · " + esc(when) + tag + (tr.target ? " · → " + esc(clip(tr.target, 30)) : "") + "</div>" +
        (sa.text ? '<div class="cc-bubble">' + esc(sa.text) + "</div>" : "") + attListHTML(sa.files) + "</div>";
    }
    if (tr.source === "peer") {
      return '<div class="cc-msg ai"><div class="who"><span class="cc-av"></span><b>' + esc(tr.actor || "A session") + "</b> · " + esc(when) + ' · peer message</div><div class="cc-bubble"><div class="cc-relay"><div class="src">' + esc(tr.actor || "session") + " → JOYA AI</div>" + md(clip(text, 4000)) + "</div></div></div>";
    }
    var line = clip(firstLine(text.replace(/\[Cross-session [a-z ]+\]/i, "")) || who, 160);
    return '<div class="cc-msg sys"><div class="cc-bubble">' + esc(who) + (tr.actor && tr.actor.toLowerCase() !== String(tr.source).toLowerCase() ? " · " + esc(aiLabel(tr.actor)) : "") + " · " + esc(when) + (line && line !== who ? " — " + esc(line) : "") + "</div></div>";
  }

  /** A sent message's files (the turn's "[Attached file: …]" lines): a thumbnail for an image, else an icon; each opens the file. */
  function attListHTML(files) {
    if (!files || !files.length) return "";
    return '<ul class="cc-sent-att" aria-label="Attached files">' + files.map(function (f) {
      var inner = (f.image && f.url ? '<img alt="" loading="lazy" src="' + esc(f.url) + '">' : '<span class="th" aria-hidden="true">' + ic(f.image ? "image" : "file") + "</span>") +
        '<span class="tx"><b>' + esc(f.name) + "</b><span>" + esc(f.size) + "</span></span>";
      return "<li>" + (f.url ? '<a href="' + esc(f.url) + '" target="_blank" rel="noopener" title="Open ' + esc(f.name) + '">' + inner + "</a>" : '<span title="' + esc(f.path) + '">' + inner + "</span>") + "</li>";
    }).join("") + "</ul>";
  }

  /** A standing order's run, as a briefing card. */
  function briefHTML(tr, body) {
    var o = tr.order_id ? P.orderById(tr.order_id) : null;
    var label = o ? o.label : "";
    return '<div class="cc-msg ai wide"><div class="cc-brief"><div class="cc-brief-h">' + ic("sun2") + "<b>" + esc(orderName(tr)) + "</b><span>" +
      esc(hm(tr.ended_at || tr.started_at || tr.created_at)) + (tr.duration_ms ? " · " + esc(dur(tr.duration_ms)) : "") + "</span></div>" +
      '<div class="cc-brief-b cc-bubble' + (tr.status === "error" ? " err" : "") + '">' + body + "</div>" +
      '<div class="cc-brief-f">' + ic("clock") + "<span>Standing order" + (label ? " · " + esc(label) : "") + (o && o.next_run_at ? " · next " + esc(P.whenText(o.next_run_at)) : "") + "</span>" +
      (o ? '<button type="button" class="cc-link" data-order="' + esc(o.id) + '">Edit</button>' : "") + "</div></div></div>";
  }

  function delegCardHTML(d) {
    var s = sessionFor(d);
    var label = { ack: "acknowledged", sent: "sent", working: "working", done: "done", failed: "failed", held: "held", denied: "denied" }[d.status] || d.status;
    var h = '<div class="cc-dcard" data-deleg="' + d.id + '">' +
      '<div class="row"><span>target</span><b>' + esc(d.target_name || d.target) + "</b></div>" +
      '<div class="row"><span>via</span><span>peer message' + (s && s.where ? " · " + esc(s.where) : "") + "</span></div>" +
      '<div class="row"><span>status</span><span class="cc-badge b-' + esc(d.status) + '">' + esc(label) + "</span>" + (d.note ? '<span class="cc-muted">' + esc(clip(d.note, 60)) + "</span>" : "") + "</div></div>";
    if (d.reply_text && (d.status === "ack" || d.status === "done")) {
      h += '<div class="cc-relay"><div class="src">Reply from ' + esc(d.target_name) + " · " + esc(hm(d.replied_at || d.done_at)) + "</div>" + md(clip(d.reply_text, 3000)) + "</div>";
    }
    return h;
  }

  function approvalTarget(a) {
    var inp = a.input || {};
    if (a.tool === "SessionRetire") return "the hired session " + String(inp.session || inp.name || "?") + " · its transcript is kept";
    if (/^session:/.test(String(a.origin || ""))) return (a.tool === "SendMessage" ? String(inp.to || "").replace(/\s*\[[0-9a-f]+\]$/, "") + " · peer message from " : "this machine · as root, for the hired session ") + ML.approvalFrom(a);
    if (a.tool === "SendMessage") return String(inp.to || "").replace(/\s*\[[0-9a-f]+\]$/, "") + " · peer message";
    return "this machine · JOYA AI runs it as root";
  }
  function approvalCmd(a) {
    var inp = a.input || {};
    if (a.tool === "SessionRetire") return { text: a.summary || "Retire a hired session", shell: false };
    if (a.tool === "SendMessage") return { text: String(inp.message || a.summary || ""), shell: false };
    if (typeof inp.command === "string") return { text: inp.command, shell: true };
    return { text: a.summary || a.tool, shell: false };
  }
  /** Who decided an approval, in words: a person, a rule, or the clock. */
  function decidedBy(a) {
    var by = String(a.decided_by || "");
    var m = /^rule:(.+)$/.exec(by);
    if (m) return "rule #" + m[1];
    return by || "you";
  }
  /** An approval card: Approve once, Always allow this (which shows the rule
      it would add before saving it), or Deny. Used in the conversation and in
      the Decisions inbox alike; one click handler serves both. */
  function approvalHTML(a) {
    var res = a.status === "pending" ? "" : a.status === "approved" ? "ok" : "no";
    var cmd = approvalCmd(a);
    var byRule = /^rule:/.test(String(a.decided_by || ""));
    var head = res === "ok" ? (byRule ? "Auto-approved" : "Approved") : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : a.status === "cancelled" ? "Withdrawn" : "Approval needed";
    var who = esc(ML.approvalFrom(a)) + (/^session:/.test(String(a.origin || "")) ? " (a session JOYA AI hired)" : "");
    var what = a.tool === "SessionRetire" ? "retire the session <b>" + esc(String((a.input || {}).session || (a.input || {}).name || "?")) + "</b>" : a.tool === "SendMessage" ? "send this to <b>" + esc(String((a.input || {}).to || "a session").replace(/\s*\[[0-9a-f]+\]$/, "")) + "</b>" : a.tool === "Bash" || a.tool === "Monitor" ? "run this command" : "use <b>" + esc(a.tool) + "</b>";
    var how = a.verified === "hello" ? " with Windows Hello" : a.verified === "totp" ? " with the authenticator code" : a.verified === "password" ? " with the password" : "";
    var resText = a.status === "approved" ? (byRule ? "Approved automatically by " + esc(decidedBy(a)) : "Approved by " + esc(decidedBy(a)) + how) + " · " + esc(hm(a.decided_at))
      : a.status === "denied" ? "Denied by " + esc(decidedBy(a)) + " · " + esc(hm(a.decided_at)) + " — nothing ran"
      : a.status === "expired" ? "Nobody answered in time — denied by default at " + esc(hm(a.decided_at))
      : a.status === "cancelled" ? "Withdrawn — answered elsewhere or the turn was interrupted" : "";
    var sug = a.rule_suggestion;
    return '<div class="cc-approval' + (res ? " resolved " + res : "") + (a.status === "denied" ? " denied" : "") + '" data-ap="' + a.id + '">' +
      '<div class="cc-ap-h">' + ic("shield") + "<span>" + head + '</span><span class="risk">destructive</span>' +
      (a.mission_ref ? '<span class="cc-badge b-mis">' + esc(a.mission_ref) + (a.step_n ? " · step " + esc(a.step_n) : "") + "</span>" : "") +
      (a.status === "pending" ? '<span class="timer" data-timer title="Nobody answering means denied">—</span><span class="cc-ap-bar" data-bar></span>' : "") + "</div>" +
      '<div class="cc-ap-body"><p>' + (a.status === "pending" ? who + " wants to " + what + ". Nothing " + (a.tool === "SessionRetire" ? "ends" : "runs") + " until you choose." : who + " asked to " + what + ".") + "</p>" +
      '<div class="cc-ap-cmd' + (cmd.shell ? " shell" : "") + '">' + esc(clip(cmd.text, 2000)) + "</div>" +
      '<dl class="cc-ap-dl"><dt>target</dt><dd>' + esc(approvalTarget(a)) + "</dd>" +
      "<dt>effect</dt><dd>" + esc(a.category ? a.category.replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : a.label || "a step the gate treats as destructive") + "</dd>" +
      (a.reason ? "<dt>reason</dt><dd>" + esc(clip(a.reason, 400)) + "</dd>" : "") + "</dl>" +
      '<div class="cc-ap-act"><button type="button" class="cc-btn pri sm" data-approve="' + a.id + '">' + ic("check") + (a.tool === "SessionRetire" ? "Retire" : "Approve once") + "</button>" +
      (ML.approvalNoRule(a) ? "" : '<button type="button" class="cc-btn sm" data-always="' + a.id + '">' + ic("scale") + "Always allow this</button>") +
      '<button type="button" class="cc-btn sm" data-deny="' + a.id + '">' + ic("close") + (a.tool === "SessionRetire" ? "Keep" : "Deny") + "</button></div>" +
      (a.status === "pending" ? '<div class="cc-ap-hint cc-ap-hello">' + esc(ML.HELLO_HINT) + "</div>" : "") +
      (a.status === "pending" && sug && sug.pattern && !ML.approvalNoRule(a) ? '<div class="cc-ap-hint">“Always allow this” would add an allow rule for <code>' + esc(clip(sug.pattern, 160)) + "</code> — you see it before it is saved.</div>" : "") +
      '<div class="cc-ap-res">' + (res === "ok" ? ic("check") : ic("close")) + "<span>" + resText + "</span></div>" +
      '<div class="cc-ap-err" data-err hidden></div></div></div>';
  }

  function turnDelegations(id) {
    var out = [];
    S.delegations.forEach(function (d) { if (d.turn_id === id) out.push(d); });
    return out.sort(function (a, b) { return a.id - b.id; });
  }
  function turnApprovals(id) {
    var out = [];
    S.approvals.forEach(function (a) { if (a.turn_id === id) out.push(a); });
    return out.sort(function (a, b) { return a.id - b.id; });
  }

  var renderQueued = new Set(), renderRaf = 0;
  /** Coalesce streaming updates to one repaint per frame. */
  function renderTurn(tr) {
    renderQueued.add(tr.id);
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(function () {
      renderRaf = 0;
      var stick = atBottom();
      renderQueued.forEach(function (id) { var x = S.turns.get(id); if (x) paintTurn(x); });
      renderQueued.clear();
      renderOrphans();
      tickApprovals();
      toBottom(stick);
      renderSay();
      if (DESKTOP) document.dispatchEvent(new CustomEvent("joya-turns"));
    });
  }
  function paintTurn(tr) {
    var el = turnEl(tr);
    var txt = aiText(tr);
    var dels = turnDelegations(tr.id), aps = turnApprovals(tr.id);
    var h = inboundHTML(tr);
    var body = "";
    if (txt) body += "<div>" + md(txt) + "</div>";
    else if (tr.status === "running") body += '<span class="cc-typing" aria-label="JOYA AI is working"><i></i><i></i><i></i></span>';
    else if (tr.status === "queued") body += '<span class="cc-muted">Queued — JOYA AI will take this next.</span>';
    if (tr.status === "interrupted") body += '<p class="cc-muted">Interrupted.</p>';
    if (tr.status === "error" && tr.error) body += '<p class="cc-muted">Stopped with an error: ' + esc(clip(tr.error, 300)) + "</p>";
    body += dels.map(delegCardHTML).join("");
    body += aps.map(approvalHTML).join("");
    if (isOrderTurn(tr)) h += briefHTML(tr, body || '<span class="cc-muted">Nothing reported.</span>');
    else if (body) {
      h += '<div class="cc-msg ai' + (aps.length ? " wide" : "") + '"><div class="who"><span class="cc-av"></span><b>JOYA AI</b> · ' + esc(hm(tr.ended_at || tr.started_at || tr.created_at)) +
        (tr.duration_ms ? " · " + dur(tr.duration_ms) : "") + '</div><div class="cc-bubble' + (tr.status === "error" ? " err" : "") + '">' + body + "</div></div>";
    }
    el.innerHTML = h;
    // The widgets JOYA AI showed with this reply (kept with the turn; the living canvas draws them).
    if (tr.widgets && tr.widgets.length && window.JoyaCanvas && window.JoyaCanvas.history) window.JoyaCanvas.history(el, tr);
  }

  /* Approvals whose turn is not on screen (older than what was loaded, or raised
     by a turn the page has not seen) still need a card somewhere. */
  function renderOrphans() {
    var list = [];
    S.approvals.forEach(function (a) { if (a.status === "pending" && !S.turns.has(a.turn_id)) list.push(a); });
    var box = chat.querySelector(".cc-orphans");
    if (!list.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement("div"); box.className = "cc-orphans"; chat.appendChild(box); }
    box.innerHTML = list.map(function (a) {
      return '<div class="cc-msg ai wide"><div class="who"><span class="cc-av"></span><b>JOYA AI</b> · ' + esc(hm(a.created_at)) + '</div><div class="cc-bubble">' + approvalHTML(a) + "</div></div>";
    }).join("");
  }

  function renderChatEmpty() {
    if (!S.turnOrder.length && !chat.querySelector(".cc-chat-empty")) {
      chat.innerHTML = '<div class="cc-chat-empty">No conversation yet. Tell JOYA AI what to do — it finds the session that owns the work and hands it over.</div>';
    }
  }

  /* Older turns on request. */
  function addMoreButton(show) {
    var b = chat.querySelector(".cc-more");
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement("button");
    b.type = "button";
    b.className = "cc-more";
    b.textContent = "Load earlier turns";
    chat.insertBefore(b, chat.firstChild);
    b.addEventListener("click", function () {
      b.disabled = true;
      var h0 = scroller.scrollHeight;
      api("ledger/turns?limit=20&before_id=" + S.oldestTurn).then(function (r) {
        var rows = (r.rows || []).filter(visibleTurn);
        rows.forEach(upsertTurn);
        b.remove();
        requestAnimationFrame(function () { requestAnimationFrame(function () { scroller.scrollTop += scroller.scrollHeight - h0; addMoreButton((r.rows || []).length === 20); }); });
      }).catch(function (e) { b.disabled = false; toast("Could not load earlier turns: " + e.message, true); });
    });
  }
  function visibleTurn(row) { return row && row.source !== "system"; }

  /** The last n exchanges, as text: what came in (yours only) and JOYA AI's answer, oldest first. */
  function recentTurns(n) {
    var out = [];
    for (var i = S.turnOrder.length - 1; i >= 0 && out.length < (n || 3); i--) {
      var tr = S.turns.get(S.turnOrder[i]);
      if (!tr || !visibleTurn(tr) || isOrderTurn(tr)) continue;
      var mine = tr.source === "dashboard" || tr.source === "voice-desk" || tr.source === "remote" || tr.source === "mission-request";
      var ai = plain(aiText(tr));
      if (!ai && tr.status === "running") ai = "…";
      if (!mine && !ai) continue;
      var sa = mine ? ML.splitAttached(String(tr.text || "")) : { text: "", files: [] };
      out.unshift({ id: tr.id, me: mine ? sa.text : "", files: sa.files.map(function (f) { return f.name; }), ai: ai });
    }
    return out;
  }
  /** Approve one approval (the desktop app's glance card): the cards' own call; api() runs the step-up on its 428. */
  function approveApproval(id) {
    var a = S.approvals.get(Number(id));
    if (!a || a.status !== "pending") return Promise.resolve(null);
    return api("approvals/" + Number(id) + "/approve", { body: {} }).then(function (r) {
      if (r && r.approval) upsertApproval(r.approval, false);
      renderNeed();
      return r;
    });
  }
  /** The desktop app's glance cards repaint when what they show changes (sessions, approvals, the event log, the status). */
  var deskPingRaf = 0;
  function deskPing() {
    if (!DESKTOP || deskPingRaf) return;
    deskPingRaf = requestAnimationFrame(function () { deskPingRaf = 0; document.dispatchEvent(new CustomEvent("joya-cc")); });
  }
  /** Deny one approval (the desktop app's toast): the card's own call, and the card follows. */
  function denyApproval(id) {
    var a = S.approvals.get(Number(id));
    if (!a || a.status !== "pending") return Promise.resolve(null);
    return api("approvals/" + Number(id) + "/deny", { body: {} }).then(function (r) {
      if (r && r.approval) upsertApproval(r.approval, false);
      renderNeed();
      return r;
    });
  }

  /* ---------------------------------------------------------- the last reply
     Under the caption, "Full reply" opens JOYA AI's last answer in full, with
     the way to the whole conversation and to hear it read aloud. */

  var replySig = "";
  /* A live call's reply is pinned while its card is up (callReply): the card follows that turn as it is written. */
  function pinnedReply() { var x = S.replyPin ? S.turns.get(S.replyPin) : null; return x && aiText(x) ? x : null; }
  function renderSay() {
    var last = pinnedReply() || lastReplyTurn();
    if (S.dockReplyPin) dockReply(S.dockReplyPin, false);
    if (!$("cc-reply").hidden && last) {
      var sig = last.id + "|" + aiText(last).length;
      if (sig !== replySig) { replySig = sig; paintReply(last); }
    }
    paintCaption();
  }
  function paintReply(last) {
    $("cc-reply-h").textContent = "JOYA AI · " + hm(last.ended_at || last.started_at || last.created_at) + (last.duration_ms ? " · " + dur(last.duration_ms) : "");
    $("cc-reply-body").innerHTML = md(aiText(last));
    $("cc-reply").setAttribute("data-turn", String(last.id));
  }
  function openReply(pin) {
    var last = pin || pinnedReply() || lastReplyTurn();
    if (!last) return;
    closePop();
    replySig = last.id + "|" + aiText(last).length;
    paintReply(last);
    $("cc-reply").hidden = false;
    $("cc-cap-more").setAttribute("aria-expanded", "true");
    $("cc-cap-more-t").textContent = "Hide reply";
    $("cc-cap-more").classList.add("open");
  }
  function closeReply() {
    S.replyPin = null;
    if ($("cc-reply").hidden) return;
    $("cc-reply").hidden = true;
    $("cc-cap-more").setAttribute("aria-expanded", "false");
    $("cc-cap-more").classList.remove("open");
    capActivity(); // the reply was just read: a fresh quiet spell before it rests again
  }
  $("cc-cap-more").addEventListener("click", function () { if ($("cc-reply").hidden) openReply(); else closeReply(); });
  $("cc-reply-x").addEventListener("click", closeReply);
  $("cc-reply").addEventListener("click", function (e) { if (e.target.closest("[data-sheet]")) closeReply(); });
  if ($("cc-reply-read")) $("cc-reply-read").addEventListener("click", function () {
    var last = lastReplyTurn();
    if (!last) return;
    Voice.unlock();
    Voice.flush("r" + last.id, aiText(last));
  });

  /* ---------------------------------------------------------- a live call's reply, on screen
     (2026-10-30, call lv1jz4g: the voice said "the details are on screen" and nothing was). When the call
     starts saying a reply ("replying": read while it is written; "replied": finished), the whole reply goes
     on the screen the administrator is looking at: the Command Center's reply panel, or -- with a page up
     in the shell, or a sheet open over the Command Center -- the dock's reply card over it. The call is
     told once it is shown ({type: "reply-shown"}); only then may the voice say the details are on screen. */

  function dockReply(id, first) {
    var d = window.__joyaDock;
    var tr = S.turns.get(id);
    if (!d || !d.reply || !tr || !aiText(tr)) return false;
    if (!first && !(d.replyOpen && d.replyOpen())) { S.dockReplyPin = null; return false; }
    return d.reply({
      head: "JOYA AI · " + (tr.status === "running" ? "writing…" : hm(tr.ended_at || tr.started_at || tr.created_at)),
      html: md(aiText(tr)),
      onOpen: function () { S.dockReplyPin = null; if (shellUp()) window.JoyaShell.expand(); setTimeout(function () { openSheet("conv"); }, shellUp() ? 450 : 0); },
    });
  }
  function callReply(id, tries) {
    id = Number(id);
    if (!id || !LiveUI.active) return;
    var tr = S.turns.get(id);
    if (!tr || !aiText(tr)) {
      // The event stream may be a moment behind the call: look again (3 s at most).
      if ((tries || 0) < 15) setTimeout(function () { callReply(id, (tries || 0) + 1); }, 200);
      return;
    }
    var shown = false;
    if (S.pane === "conv") shown = true; // the conversation itself is open: the reply is in it
    else if (shellUp() || S.pane) { S.dockReplyPin = id; shown = dockReply(id, true); }
    else { S.replyPin = id; openReply(tr); shown = !$("cc-reply").hidden; }
    if (shown && window.VoiceLive && window.VoiceLive.tell) window.VoiceLive.tell({ type: "reply-shown", turn: id });
  }
  /* What is on the administrator's screen, for the call (sent when it changes): the page and the panel open. */
  var screenSig = "";
  function screenNow() {
    var w = shellUp() && window.JoyaShell.where ? window.JoyaShell.where() : null;
    if (w) return { path: w.path, title: w.title || w.path, panel: (window.__joyaDock && window.__joyaDock.replyOpen && window.__joyaDock.replyOpen()) ? "JOYA AI's reply card" : "" };
    var panel = "";
    if (S.pane) {
      var b = document.querySelector('#cc-rail [data-sheet="' + S.pane + '"]');
      panel = "the " + ((b && (b.getAttribute("aria-label") || b.textContent || "").trim()) || S.pane) + " sheet";
    } else if (!$("cc-reply").hidden) panel = "JOYA AI's full reply";
    return { path: "/joya-ai", title: "Command Center", panel: panel };
  }
  function screenTick() {
    if (!LiveUI.active || !window.VoiceLive || !window.VoiceLive.tell) return;
    var sc = screenNow();
    var sig = sc.path + "|" + sc.title + "|" + sc.panel;
    if (sig === screenSig) return;
    screenSig = sig;
    window.VoiceLive.tell({ type: "screen", path: sc.path, title: String(sc.title).slice(0, 100), panel: String(sc.panel).slice(0, 120) });
  }

  /* ---------------------------------------------------------- approvals */

  function tickApprovals() {
    var els = document.querySelectorAll(".cc-approval [data-timer]");
    for (var i = 0; i < els.length; i++) {
      var card = els[i].closest("[data-ap]");
      var a = S.approvals.get(Number(card.getAttribute("data-ap")));
      if (!a || a.status !== "pending") continue;
      var left = Math.max(0, Math.round((Date.parse(a.expires_at) - nowServer()) / 1000));
      var total = Math.max(1, Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 1000));
      els[i].textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left";
      els[i].classList.toggle("low", left < 60);
      var bar = card.querySelector("[data-bar]");
      if (bar) bar.style.transform = "scaleX(" + (left / total).toFixed(3) + ")";
    }
  }

  function upsertApproval(a, replay) {
    if (!a || !a.id) return;
    var cur = S.approvals.get(a.id);
    if (cur && cur.status !== "pending" && a.status === "pending") return;   // an older event replayed
    S.approvals.set(a.id, a);
    var tr = S.turns.get(a.turn_id);
    if (tr) renderTurn(tr); else renderTurn({ id: -1 });
    P.renderDecisions();
    renderTimeline();
    if (!replay && a.status === "pending" && (!cur || cur.status !== "pending")) {
      openNeed("a" + a.id);
      feedPush({ key: "ap" + a.id + "p", ts: a.created_at, kind: "approval", html: "<b>Approval needed</b> · " + esc(clip(a.summary, 140)) });
      if (Voice.on) Voice.say("I need your approval before I go on.");
      sound("approval");
    }
    if (!replay && a.status !== "pending" && (!cur || cur.status === "pending")) {
      if (a.status === "approved" && Orb.react) Orb.react("nod"); // core E: a nod when an approval goes through
      feedPush({ key: "ap" + a.id + a.status, ts: a.decided_at, kind: a.status === "approved" ? "approved" : a.status, html: "<b>" + esc(a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : "Withdrawn") + "</b>" + (a.decided_by && a.decided_by !== "timeout" ? " by " + esc(decidedBy(a)) : "") + " · " + esc(clip(a.summary, 120)) });
    }
    paintState();
    renderRail();
    deskPing();
  }

  /* One handler for every approval card on the page (conversation or inbox). */
  function approvalClick(e) {
    var a = e.target.closest("[data-approve]"), d = e.target.closest("[data-deny]"), al = e.target.closest("[data-always]");
    var btn = a || d || al;
    if (!btn || btn.disabled) return;
    var card = btn.closest("[data-ap]");
    if (al) { P.openAlways(Number(al.getAttribute("data-always"))); return; }
    var id = Number(btn.getAttribute(a ? "data-approve" : "data-deny"));
    var buttons = card.querySelectorAll(".cc-ap-act button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    var err = card.querySelector("[data-err]");
    api("approvals/" + id + "/" + (a ? "approve" : "deny"), { body: {} }).then(function (r) {
      if (r && r.approval) upsertApproval(r.approval, false);
    }).catch(function (ex) {
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      if (err) { err.hidden = false; err.textContent = "Not recorded: " + ex.message; }
    });
  }
  chat.addEventListener("click", approvalClick);
  $("cc-dec-list").addEventListener("click", approvalClick);
  chat.addEventListener("click", function (e) {
    var o = e.target.closest("[data-order]");
    if (o) P.openOrder(o.getAttribute("data-order"));
  });

  /* ---------------------------------------------------------- the decision card
     One card, top right, for everything waiting for you: approvals first (they
     expire), then watcher findings. It pages through them, and each button is
     the same call the Decisions sheet makes (JoyaLogic.card names the route).
     "Later" puts it away; the amber "N need you" pill brings it back. */

  var Need = { open: false, idx: 0, sig: "", busy: false, seen: {} };
  function needQueue() {
    return ML.needQueue(pendingApprovals(), typeof P !== "undefined" && P ? P.decisionsList() : []);
  }
  function openNeed(key) {
    var q = needQueue();
    if (!q.length) return;
    var i = key ? q.map(function (x) { return x.key; }).indexOf(key) : -1;
    Need.idx = i >= 0 ? i : Math.min(Need.idx, q.length - 1);
    Need.open = true;
    Need.sig = "";
    renderNeed();
  }
  function closeNeed() {
    Need.open = false;
    Need.sig = "";
    renderNeed();
  }
  function renderNeed() {
    var q = needQueue(), n = q.length;
    $("cc-needn").textContent = n;
    if (n !== renderNeed.lastN) { renderNeed.lastN = n; document.dispatchEvent(new CustomEvent("joya-needs", { detail: { n: n } })); } // the OS drawer's badge (os.js)
    $("cc-needpill").hidden = !n || Need.open;
    var mir = document.querySelectorAll("[data-dec-mirror]");
    for (var m = 0; m < mir.length; m++) { mir[m].textContent = n; mir[m].hidden = !n; }
    var box = $("cc-need");
    if (Need.busy) return;
    if (!n || !Need.open) {
      if (!box.hidden) { box.hidden = true; box.innerHTML = ""; }
      if (!n) Need.open = false;
      return;
    }
    Need.idx = Math.max(0, Math.min(Need.idx, n - 1));
    var it = q[Need.idx], c = ML.card(it);
    var sig = it.key + "|" + n + "|" + Need.idx + "|" + c.title + "|" + c.why + "|" + c.actions.map(function (x) { return x.act; }).join(",");
    box.hidden = false;
    if (sig === Need.sig) return;
    Need.sig = sig;
    box.setAttribute("data-kind", c.kind.toLowerCase());
    box.innerHTML = '<div class="k">' + ic(c.icon) + "<span>Needs you · " + esc(c.kind) + '</span><span class="sp"></span>' +
      '<span class="pg">' + (n > 1 ? '<button type="button" data-need-pg="-1" aria-label="Previous">' + ic("chevl") + "</button>" : "") + (Need.idx + 1) + " of " + n +
      (n > 1 ? '<button type="button" data-need-pg="1" aria-label="Next">' + ic("chevr") + "</button>" : "") + "</span></div>" +
      "<h3>" + esc(c.title) + "</h3>" + (c.meta ? '<div class="meta">' + esc(c.meta) + "</div>" : "") +
      (c.why ? '<p class="why">' + esc(c.why) + "</p>" : "") +
      (c.hello ? '<p class="hello">' + ic("shield") + "<span>" + esc(ML.HELLO_HINT) + "</span></p>" : "") +
      (it.type === "approval" ? '<div class="timer"><span data-need-timer>—</span><span class="bar"><i data-need-bar></i></span></div>' : "") +
      '<div class="acts">' + c.actions.map(function (x, i) {
        if (x.link) return "";
        return (x.act === "later" ? '<span class="sp"></span>' : "") +
          '<button type="button" class="cc-btn ' + (x.primary ? "pri" : x.act === "later" ? "link" : "") + '" data-need-act="' + i + '">' + (x.primary ? ic("check") : "") + esc(x.label) + "</button>";
      }).join("") + "</div>" +
      c.actions.map(function (x, i) { return x.link ? '<button type="button" class="more" data-need-act="' + i + '">' + ic("scale") + esc(x.label) + "</button>" : ""; }).join("") +
      '<div class="err" data-need-err hidden></div>';
    tickNeed();
  }
  function tickNeed() {
    var el = document.querySelector("[data-need-timer]");
    if (!el) return;
    var q = needQueue(), it = q[Need.idx];
    if (!it || it.type !== "approval") return;
    var a = it.item;
    var left = Math.max(0, Math.round((Date.parse(a.expires_at) - nowServer()) / 1000));
    var total = Math.max(1, Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 1000));
    if (!isFinite(left)) return;
    el.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left · then denied";
    el.classList.toggle("low", left < 60);
    var bar = document.querySelector("[data-need-bar]");
    if (bar) bar.style.transform = "scaleX(" + (left / total).toFixed(3) + ")";
  }
  $("cc-need").addEventListener("click", function (e) {
    var pg = e.target.closest("[data-need-pg]");
    var q = needQueue();
    if (pg) { Need.idx = (Need.idx + Number(pg.getAttribute("data-need-pg")) + q.length) % q.length; Need.sig = ""; renderNeed(); return; }
    var b = e.target.closest("[data-need-act]");
    if (!b || b.disabled || Need.busy) return;
    var it = q[Need.idx], c = ML.card(it);
    var act = c && c.actions[Number(b.getAttribute("data-need-act"))];
    if (!act) return;
    if (act.act === "later") { closeNeed(); return; }
    if (act.act === "always") { P.openAlways(it.id); return; }
    var bs = $("cc-need").querySelectorAll("[data-need-act]");
    for (var i = 0; i < bs.length; i++) bs[i].disabled = true;
    b.classList.add("pressed");
    Need.busy = true;
    api(act.path, { body: act.body }).then(function (r) {
      $("cc-need").classList.add("done");
      $("cc-need").querySelector(".k span").textContent = ML.doneText(act.act);
      setTimeout(function () {
        Need.busy = false;
        $("cc-need").classList.remove("done");
        Need.sig = "";
        if (r && r.approval) upsertApproval(r.approval, false);
        if (r && r.decision) P.upsertDecision(r.decision, true);
        if (r && r.turn) upsertTurn(r.turn);
        renderNeed();
        paintState();
      }, 700);
    }).catch(function (ex) {
      Need.busy = false;
      for (var j = 0; j < bs.length; j++) bs[j].disabled = false;
      b.classList.remove("pressed");
      var err = $("cc-need").querySelector("[data-need-err]");
      if (err) { err.hidden = false; err.textContent = "Not recorded: " + ex.message; }
    });
  });
  $("cc-needpill").addEventListener("click", function () { Need.idx = 0; openNeed(); });

  /* ---------------------------------------------------------- the voice menu
     Under the composer: the live call (voice is live conversation only),
     speakers or headphones for this browser, replies read aloud, the way to
     Settings ▸ Voice, the JOYA AI core (a quick switch, saved for you), and
     the voice's spend. With voice off only the note, the core and the spend. */

  function closePop() {
    var p = $("cc-pop");
    if (p.hidden) return;
    p.hidden = true;
    p.innerHTML = "";
    p.removeAttribute("data-kind");
    $("cc-vm").setAttribute("aria-expanded", "false");
    $("cc-attach").setAttribute("aria-expanded", "false");
  }
  function openVoiceMenu() {
    var p = $("cc-pop"), manage = root.getAttribute("data-voice-manage") === "1";
    var dx = LiveUI && LiveUI.duplex === "full" ? "full" : "speakers";
    var h = '<div class="grp">Voice</div>' +
      (LIVE_OK
        ? '<div class="line">' + ic("voice") + "<span>Live · " + esc(VOICE || "voice") + "</span></div>" +
          '<button type="button" role="menuitemradio" data-dx="speakers" aria-checked="' + (dx === "speakers") + '"><span class="chk"></span>Speakers mode<small>mic pauses while it speaks</small></button>' +
          '<button type="button" role="menuitemradio" data-dx="full" aria-checked="' + (dx === "full") + '"><span class="chk"></span>Headphones mode<small>talk over it</small></button>'
        : '<div class="line">' + ic("info") + "<span>" + (READY ? "Live conversation is not supported in this browser." : "Voice is off.") + "</span></div>") +
      (manage ? '<div class="line">' + ic("route") + '<span>Settings</span><a href="/joya-ai/settings/voice">Voice settings</a></div>' : "") +
      "<hr>" + '<div class="grp">JOYA AI core</div>' +
      '<div class="cc-core-seg" role="radiogroup" aria-label="JOYA AI core">' + Object.keys(ML.CORES).map(function (k) {
        return '<button type="button" role="radio" data-core-set="' + k + '" aria-checked="' + (k === coreNow()) + '"><b>' + k + "</b><span>" + esc(ML.CORES[k]) + "</span></button>";
      }).join("") + "</div><hr>" +
      '<button type="button" data-sheet="cost">' + ic("coin") + "Voice usage<small id=\"cc-pop-vu\">" + esc(P.voiceToday ? P.voiceToday() : "") + "</small></button>";
    p.innerHTML = h;
    p.setAttribute("data-kind", "voice");
    p.hidden = false;
    $("cc-attach").setAttribute("aria-expanded", "false");
    $("cc-vm").setAttribute("aria-expanded", "true");
    var r = $("cc-vm").getBoundingClientRect(), pr = p.getBoundingClientRect();
    var x = Math.min(window.innerWidth - pr.width - 12, Math.max(12, r.left + r.width / 2 - pr.width / 2));
    p.style.left = x + "px";
    p.style.top = Math.max(12, r.top - pr.height - 8) + "px";
  }
  $("cc-vm").addEventListener("click", function (e) {
    e.stopPropagation();
    if ($("cc-pop").hidden || $("cc-pop").getAttribute("data-kind") !== "voice") openVoiceMenu(); else closePop();
  });
  $("cc-pop").addEventListener("click", function (e) {
    e.stopPropagation();
    var dxb = e.target.closest("[data-dx]");
    if (dxb) { liveDuplex(dxb.getAttribute("data-dx")); openVoiceMenu(); return; }
    var cs = e.target.closest("[data-core-set]");
    if (cs) { setCoreChoice(cs.getAttribute("data-core-set")); openVoiceMenu(); return; }
    if (e.target.closest("[data-sheet]")) { var k = e.target.closest("[data-sheet]").getAttribute("data-sheet"); closePop(); openSheet(k); }
  });
  document.addEventListener("click", function (e) { if (!$("cc-pop").hidden && !e.target.closest("#cc-pop") && !e.target.closest("#cc-vm") && !e.target.closest("#cc-attach")) closePop(); });

  /* ---------------------------------------------------------- activity */

  // Tools the supervisor has no plain-English line for arrive as their bare name.
  var STEP_NAMES = { ToolSearch: "Loaded the tools it needs", TodoWrite: "Updated its plan", ListAgents: "Listed the live sessions",
    ExitPlanMode: "Finished planning", NotebookEdit: "Edited a notebook", Skill: "Opened a skill" };
  function renderSteps() {
    var box = $("cc-steps");
    var cur = S.status && S.status.current_turn;
    var tr = cur ? S.turns.get(cur.id) || cur : null;
    var lastTurn = null;
    if (!tr) {
      for (var i = S.turnOrder.length - 1; i >= 0; i--) { var x = S.turns.get(S.turnOrder[i]); if (x && x.source !== "system") { lastTurn = x; break; } }
    }
    var show = tr || lastTurn;
    var steps = S.steps && show && S.steps.turn_id === show.id ? S.steps.steps : cur && show && cur.id === show.id ? cur.steps || [] : [];
    var items = [];
    if (show) {
      items.push({ st: "done", txt: (TURN_SRC[show.source] === "You" ? "Took your request" : "Picked up: " + (TURN_SRC[show.source] || "a turn").toLowerCase()) + (show.text ? " — " + clip(firstLine(show.text), 60) : ""), t: show.started_at || show.created_at });
      (steps || []).forEach(function (s) {
        var txt = STEP_NAMES[s.txt] || s.txt;
        items.push({ st: s.st === "wait" ? "wait" : s.st === "error" ? "error" : s.st === "run" ? "run" : "done", txt: s.st === "wait" ? "Needs your approval — " + txt : txt, t: s.done_at || s.t, sub: s.sub });
      });
      if (show.status === "running" && !items.some(function (s) { return s.st === "run" || s.st === "wait"; })) items.push({ st: "run", txt: aiText(show) ? "Writing the answer" : "Thinking", t: "" });
      if (show.status === "done") items.push({ st: "done", txt: "Answered" + (show.duration_ms ? " in " + dur(show.duration_ms) : ""), t: show.ended_at });
      if (show.status === "interrupted") items.push({ st: "error", txt: "Interrupted", t: show.ended_at });
      if (show.status === "error") items.push({ st: "error", txt: "Ended with an error", t: show.ended_at });
    }
    var busy = items.some(function (s) { return s.st === "run"; }), waiting = items.some(function (s) { return s.st === "wait"; });
    $("cc-act-dot").className = "cc-dot " + (waiting ? "warn" : busy ? "work" : "idle");
    $("cc-act-sub").textContent = tr ? "turn " + hm(tr.started_at || tr.created_at) : lastTurn ? "last turn " + hm(lastTurn.started_at || lastTurn.created_at) : "idle";
    if (!items.length) { box.innerHTML = '<li class="empty"><span class="sx"></span><span>Waiting for something to do.</span></li>'; return; }
    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
    box.innerHTML = items.map(function (s) {
      var mark = s.st === "done" ? ic("check") : s.st === "wait" ? "!" : s.st === "error" ? "×" : "";
      return '<li class="' + s.st + (s.sub ? " sub" : "") + '"><span class="sx">' + mark + "</span><span>" + esc(s.txt) + "</span><time>" + esc(hms(s.t)) + "</time></li>";
    }).join("");
    if (stick) box.scrollTop = box.scrollHeight;
  }

  /* ---------------------------------------------------------- timeline */

  var TL_LAB = { done: "done", working: "working", sent: "sent", ack: "acknowledged", failed: "failed", held: "held", denied: "denied",
    pending: "needs approval", approved: "approved", expired: "expired", cancelled: "withdrawn" };
  var tlRaf = 0;
  function renderTimeline() {
    if (tlRaf) return;
    tlRaf = requestAnimationFrame(function () {
      tlRaf = 0;
      var rows = [];
      S.delegations.forEach(function (d) { rows.push({ kind: "d", ts: d.created_at, r: d }); });
      S.approvals.forEach(function (a) { rows.push({ kind: "a", ts: a.created_at, r: a }); });
      rows.sort(function (x, y) { return Date.parse(y.ts) - Date.parse(x.ts); });
      rows = rows.slice(0, 120);
      $("cc-tl-count").textContent = rows.length;
      if (!rows.length) { $("cc-timeline").innerHTML = '<li class="empty">No delegations yet. They appear here as JOYA AI hands work to other sessions.</li>'; return; }
      $("cc-timeline").innerHTML = rows.map(function (x) {
        var r = x.r;
        if (x.kind === "d") {
          var bits = [];
          if (r.status === "done" && r.done_at) bits.push(dur(Date.parse(r.done_at) - Date.parse(r.created_at)));
          if (r.note) bits.push(r.note);
          else if (r.status === "ack" && r.replied_at) bits.push("replied " + hms(r.replied_at));
          return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t full">' + esc(r.text || r.summary || "") + "</div><small>→ <b>" + esc(r.target_name) + "</b>" + (bits.length ? " · " + esc(clip(bits.join(" · "), 90)) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
        }
        var who = r.decided_by && r.decided_by !== "timeout" ? (r.status === "approved" ? "approved" : "decided") + " by " + decidedBy(r) : r.status === "expired" ? "nobody answered" : "";
        return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t">' + esc(clip(approvalCmd(r).text, 160)) + "</div><small>→ <b>" + esc(r.tool === "SendMessage" ? approvalTarget(r).replace(" · peer message", "") : "JOYA AI") + "</b> · approval" + (r.category ? " · " + esc(r.category.replace(/_/g, " ")) : "") + (who ? " · " + esc(who) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
      }).join("");
    });
  }

  function upsertDelegation(d, replay) {
    if (!d || !d.id) return;
    var cur = S.delegations.get(d.id);
    if (cur && d.updated_at && cur.updated_at && d.updated_at < cur.updated_at) return;
    S.delegations.set(d.id, d);
    ALIAS.learnDelegation(d);
    var res = ML.resolveTarget(d, S.sessions, ALIAS), s = res.session;
    if (!replay && !cur && d.status === "sent") {
      S.delegatingUntil = Date.now() + 2600;
      S.delegTo = d.target_name || d.target || "a session";
      S.delegText = d.summary || firstLine(d.text) || "";
      // Always (re)aim the stream: at its sphere, or -- with none here (remote, sub-agent, offline,
      // ambiguous) -- at a marker at the edge; never at the last target or at empty space.
      if (s && Orb.send(sessKey(s), 2600)) highlightSess(sessKey(s));
      else { Orb.send(null, 2600); if (Orb.ghost) Orb.ghost(d.target_name || d.target || "a session", ML.ghostWhere(d, res.why), 2600); }
      paintState();
      feedPush({ key: "d" + d.id + "sent", ts: d.created_at, kind: "live", label: "sent", html: "Delegated to <b>" + esc(d.target_name) + "</b> · " + esc(clip(d.summary || firstLine(d.text), 120)) });
    }
    // (The session's answer comes home once, with its inbound message -- inboundFeed -- not again on the ack.)
    if (!replay && cur && cur.status !== d.status && d.status === "done") sound("job");
    if (!replay && cur && cur.status !== d.status && d.status === "failed") sound("error", s ? sessHead(s).role : "other");
    if (!replay && cur && cur.status !== d.status && (d.status === "failed" || d.status === "held")) {
      feedPush({ key: "d" + d.id + d.status, ts: d.updated_at, kind: d.status === "failed" ? "failed" : "held", html: "<b>" + esc(d.target_name) + "</b> · delegation " + esc(d.status) + (d.note ? " — " + esc(clip(d.note, 120)) : "") });
    }
    var tr = S.turns.get(d.turn_id);
    if (tr) renderTurn(tr);
    renderTimeline();
    renderStats();
    renderSessions(); // a sphere's task and size follow its delegations
  }

  /* ---------------------------------------------------------- event log */

  var FEED_MAX = 100;
  function feedPush(item, quiet) {
    if (!item.key) item.key = "f" + Math.random();
    for (var i = 0; i < S.feed.length; i++) if (S.feed[i].key === item.key) return;
    item.isNew = !quiet;
    S.feed.push(item);
    S.feed.sort(function (a, b) { return Date.parse(b.ts || 0) - Date.parse(a.ts || 0); });
    if (S.feed.length > FEED_MAX) S.feed.length = FEED_MAX;
    renderFeed();
    deskPing();
  }
  var feedRaf = 0;
  function renderFeed() {
    if (feedRaf) return;
    feedRaf = requestAnimationFrame(function () {
      feedRaf = 0;
      $("cc-feed-count").textContent = S.feed.length;
      if (!S.feed.length) { $("cc-feed").innerHTML = '<li class="empty">Replies, idle notices and service events appear here as they happen.</li>'; return; }
      $("cc-feed").innerHTML = S.feed.map(function (f) {
        return "<li" + (f.isNew ? ' class="new"' : "") + "><time>" + esc(hm(f.ts)) + "</time><p>" + f.html + '</p><span class="cc-badge b-' + esc(f.kind) + '">' + esc(f.label || f.kind) + "</span></li>";
      }).join("");
      S.feed.forEach(function (f) { f.isNew = false; });
    });
  }
  function inboundFeed(row, quiet) {
    if (!row || !row.id || S.inbound.has(row.id)) return;
    S.inbound.set(row.id, row);
    var kind = row.kind === "message" ? "reply" : row.kind;
    var text = String(row.text || "").replace(/\[Cross-session [a-z ]+\]/i, "").trim();
    feedPush({
      key: "in" + row.id, ts: row.received_at, kind: kind, label: kind,
      html: "<b>" + esc(row.from_name || "a session") + "</b> → " + (row.kind === "message" ? "" : esc(row.kind) + " ") + '<span class="q">' + esc(clip(text, 300)) + "</span>",
    }, quiet);
    // A session writing back to JOYA AI: a reply bead comes home.
    if (!quiet) {
      var s = ML.resolveFrom(row, S.sessions);
      if (s) Orb.reply(sessKey(s));
    }
    renderSessions(); // a sphere's hover card shows its last message
  }

  /* ---------------------------------------------------------- stats */

  function renderStats() {
    var c = (S.status && S.status.counts) || {};
    $("cc-stat-deleg").textContent = c.delegations_24h == null ? "—" : c.delegations_24h;
    var since = Date.now() - 24 * 3600 * 1000, done = 0;
    S.delegations.forEach(function (d) { if (d.status === "done" && Date.parse(d.created_at) >= since) done++; });
    $("cc-stat-done").textContent = done;
    var ds = [];
    S.turns.forEach(function (tr) { if (tr.duration_ms && (tr.source === "dashboard" || tr.source === "voice-desk" || tr.source === "remote")) ds.push(tr.duration_ms); });
    ds.sort(function (a, b) { return a - b; });
    $("cc-stat-median").textContent = ds.length ? dur(ds[Math.floor((ds.length - 1) / 2)]) : "—";
  }

  function renderDrawerHead() {
    var p = (S.status && S.status.process) || {};
    var me = selfSession();
    var sub = "CEO" + (p.model ? " · " + modelLabel(p.model) : "") + " · " + ((me && me.cwd) || "/root/joya-ai");
    $("cc-dr-sub").textContent = sub;
    $("cc-dr-sub").title = "CEO session · " + sub.slice(6);
    var rc = (S.status && S.status.remote_control) || {};
    var on = rc.enabled && (rc.state === "connected" || !rc.state);
    $("cc-rc-dot").className = "cc-dot" + (on ? "" : rc.enabled ? " warn" : " off");
    $("cc-rc-text").textContent = !S.online ? "Remote Control state unknown while JOYA AI is unreachable." : on
      ? "Mirrors the JOYA AI session — the same conversation in Claude Desktop (Remote Control) and here."
      : rc.enabled ? "Remote Control is " + (rc.state || "starting") + " — Claude Desktop may not see this conversation yet."
      : "Remote Control is off — this conversation is only here.";
    $("cc-rc-open").disabled = !rc.enabled;
  }

  function renderAll() {
    renderRail();
    renderSessions();
    renderSteps();
    renderStats();
    renderDrawerHead();
    renderTimeline();
    renderFeed();
    P.renderAll();
    paintState();
    var off = $("cc-offline");
    off.hidden = S.online;
    $("cc-offline-msg").textContent = S.offlineMsg || "";
  }

  /* ================================================================ loading */

  function setStatus(st) {
    var keepMachine = S.status && S.status.machine;
    S.status = st;
    if (st && !st.machine && keepMachine) st.machine = keepMachine;
    if (st && st.approvals) st.approvals.forEach(function (a) { S.approvals.set(a.id, a); });
    deskPing();
  }

  function load() {
    return api("overview").then(function (ov) {
      S.online = true;
      S.offlineMsg = "";
      setStatus(ov.status);
      setSessions((ov.sessions && ov.sessions.sessions) || []);
      S.memory = ov.memory;
      S.agents = ov.agents;
      S.loadSeq = ov.status.seq || 0;
      (ov.timeline || []).forEach(function (d) { S.delegations.set(d.id, d); });
      P.load(ov);
      return Promise.all([
        api("ledger/turns?limit=40").catch(function () { return { rows: [] }; }),
        api("ledger/approvals?limit=60").catch(function () { return { rows: [] }; }),
        api("ledger/delegations?limit=150").catch(function () { return { rows: [] }; }),
        api("ledger/inbound?limit=40").catch(function () { return { rows: [] }; }),
      ]);
    }).then(function (r) {
      (r[1].rows || []).forEach(function (a) { if (!S.approvals.has(a.id) || a.status !== "pending") S.approvals.set(a.id, a); });
      (r[2].rows || []).forEach(function (d) { S.delegations.set(d.id, d); });
      (r[3].rows || []).slice().reverse().forEach(function (row) { inboundFeed(row, true); });
      var rows = (r[0].rows || []).filter(visibleTurn).reverse();
      rows.forEach(upsertTurn);
      var cur = S.status.current_turn;
      if (cur) { upsertTurn(cur); S.steps = { turn_id: cur.id, steps: cur.steps || [] }; }
      renderChatEmpty();
      addMoreButton((r[0].rows || []).length === 40);
      renderAll();
      renderTurn({ id: -1 });
      requestAnimationFrame(function () { toBottom(true); });
      // Approvals expire: any already waiting get the card at once.
      if (pendingApprovals().length) openNeed();
      connect(0);
    }).catch(function (e) {
      S.online = false;
      S.offlineMsg = e.status === 403 ? "Your role does not include JOYA AI." : e.message;
      renderAll();
      renderChatEmpty();
      setTimeout(load, 5000);
    });
  }

  /* ================================================================ events */

  var es = null, reconnectTimer = 0;
  var EVENTS = ["proc", "init", "rc", "status", "turn", "text", "assistant", "tool", "tool_result", "steps", "result", "approval", "delegation", "inbound", "sessions", "vitals", "notice", "offline",
    "mission", "decision", "watcher", "order", "order_run", "rule", "machine", "ui", "ui-confirm"];

  function connect(since) {
    if (es) es.close();
    es = new EventSource("/joya-ai/api/events?tab=" + encodeURIComponent(TAB_ID) + (since ? "&since=" + since : ""));
    es.onopen = function () {
      if (!S.online) {
        // Back after an outage: the supervisor may have restarted, which resets
        // its sequence -- re-read the state rather than trust a stale cursor.
        S.online = true;
        api("status").then(function (st) {
          if (st.seq < S.lastSeq) { S.lastSeq = 0; S.loadSeq = st.seq; connect(0); }
          setStatus(st);
          renderAll();
        }).catch(function () { /* the stream will say */ });
        P.load();
        renderAll();
      }
    };
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () { connect(S.lastSeq); }, 4000);
      }
    };
    EVENTS.forEach(function (type) {
      es.addEventListener(type, function (m) {
        var ev;
        try { ev = JSON.parse(m.data); } catch (e) { return; }
        onEvent(type, ev);
      });
    });
  }

  function onEvent(type, ev) {
    if (type === "ui-confirm") {
      // A confirm this user was asked ran out on the server (nothing changed): the chip says so,
      // and the relay desk's voice says it once (a live call says it itself).
      if (ev && ev.state === "expired") uiConfirmExpired(ev.id, ev.line);
      return;
    }
    if (type === "ui") {
      // JOYA AI's own screen action (its ui_action), sent to this tab only by the
      // server; done like the voice's, and answered so JOYA AI knows.
      if (!ev || !ev.nonce || typeof runUiAction !== "function") return;
      // A widget (JOYA AI's ui_widget): the living canvas draws it beside the reply (joya-canvas.js).
      if (ev.action === "widget.show") {
        var wr = window.JoyaCanvas ? window.JoyaCanvas.offer(ev) : { ok: false, why: "this page has no board" };
        api("ui/ack", { body: { nonce: ev.nonce, ok: !!wr.ok, why: wr.ok ? undefined : String(wr.why || "").slice(0, 200) } }).catch(function () { /* the supervisor times out */ });
        return;
      }
      var res = runUiAction(ev);
      if (ev.confirm) return; // a Tier-2 question: the server already told JOYA AI it waits for a confirm
      api("ui/ack", { body: { nonce: ev.nonce, ok: !!res.ok, why: res.ok ? undefined : String(res.why || "").slice(0, 200) } }).catch(function () { /* the supervisor times out */ });
      return;
    }
    var replay = !!(ev.seq && ev.seq <= S.loadSeq);
    if (ev.seq) S.lastSeq = Math.max(S.lastSeq, ev.seq);
    if (!replay && ev.ts) S.skew = Date.parse(ev.ts) - Date.now();
    if (type === "offline") {
      S.online = false;
      S.offlineMsg = ev.error || "JOYA AI's supervisor is not running";
      renderAll();
      return;
    }
    if (!S.online) { S.online = true; renderAll(); }
    var st = S.status || (S.status = {});
    switch (type) {
      case "vitals":
        st.vitals = ev.vitals;
        if (st.machine && ev.vitals) st.machine.vitals = ev.vitals;
        renderMachine();
        return;
      case "machine":
        if (ev.machine) {
          if (st.machine && st.machine.services && ev.machine.services && !replay) diffServices(st.machine.services, ev.machine.services, ev.ts);
          st.machine = ev.machine;
        }
        renderMachine();
        paintState();
        return;
      case "sessions": {
        var before = S.sessions;
        setSessions(ev.sessions || []);
        st.sessions_at = ev.ts;
        if (!replay) diffSessions(before, S.sessions, ev.ts);
        renderSessions();
        renderRail();
        P.sessionsChanged();
        if (S.target !== "auto" && !liveSessions().some(function (s) { return s.name === S.target; })) {
          if (!replay) toast("“" + S.target + "” stopped running — back to auto-route.", true);
          setTarget("auto");
        }
        return;
      }
      case "turn": {
        var row = ev.turn;
        if (!row || !visibleTurn(row)) return;
        var tr = upsertTurn(row);
        if (ev.phase === "start") {
          st.busy = true;
          st.current_turn = row;
          S.steps = { turn_id: row.id, steps: [] };
        }
        if (ev.phase === "end") {
          if (st.current_turn && st.current_turn.id === row.id) st.current_turn = null;
          st.busy = false;
          if (tr) {
            tr.partial = "";
            if (!replay) S.liveReplies.add(row.id);
            if (!replay && voiceTurns.has(row.id)) { Voice.flush(row.id, aiText(tr)); voiceTurns.delete(row.id); }
          }
          if (!replay && row.status === "error") feedPush({ key: "t" + row.id + "err", ts: ev.ts, kind: "error", html: "<b>Turn ended with an error</b> · " + esc(clip(row.error || "", 140)) });
          refreshCounts();
        }
        renderSteps();
        renderStats();
        paintState();
        renderSessions(true);
        return;
      }
      case "text": {
        var tt = S.turns.get(ev.turn_id);
        if (!tt) return;
        tt.partial += ev.delta || "";
        if (voiceTurns.has(tt.id)) Voice.feed(tt.id, aiText(tt));
        renderTurn(tt);
        return;
      }
      case "assistant": {
        if (ev.parent_tool_use_id) return;
        var ta = S.turns.get(ev.turn_id);
        if (!ta) return;
        // A finished turn loaded from the ledger already has its answer.
        if (replay && ta.status !== "running" && ta.result_text) return;
        ta.blocks.push(ev.text || "");
        ta.partial = "";
        if (!replay && voiceTurns.has(ta.id)) Voice.feed(ta.id, aiText(ta));
        renderTurn(ta);
        renderSteps();
        return;
      }
      case "steps":
        S.steps = { turn_id: ev.turn_id, steps: ev.steps || [] };
        renderSteps();
        return;
      case "tool":
      case "tool_result":
        return;   // the steps event that follows carries the same, summarised
      case "result":
        if (ev.turn) {
          var tr2 = upsertTurn(ev.turn);
          if (tr2 && !tr2.blocks.length && tr2.result_text && !replay && voiceTurns.has(tr2.id)) Voice.feed(tr2.id, tr2.result_text);
        }
        return;
      case "approval":
        upsertApproval(ev.approval, replay);
        return;
      case "delegation":
        upsertDelegation(ev.delegation, replay);
        return;
      case "inbound":
        inboundFeed(ev.inbound, replay);
        return;
      case "notice":
        feedPush({ key: "n" + ev.seq, ts: ev.ts, kind: ev.level === "warn" ? "warn" : "info", label: ev.level || "info", html: esc(ev.text || "") }, replay);
        return;
      case "proc":
        st.process = st.process || {};
        if (ev.state) st.process.state = ev.state;
        if (ev.pid) st.process.pid = ev.pid;
        feedPush({ key: "p" + ev.seq, ts: ev.ts, kind: ev.state === "ready" ? "info" : ev.state === "error" || ev.state === "blocked" ? "error" : "warn", label: "service",
          html: "<b>JOYA AI process</b> · " + esc(ev.state || "") + (ev.error ? " — " + esc(clip(ev.error, 120)) : "") + (ev.retry_in_s ? " · retry in " + ev.retry_in_s + "s" : "") }, replay);
        renderRail();
        paintState();
        return;
      case "init":
        st.process = st.process || {};
        if (ev.model) st.process.model = ev.model;
        renderRail();
        renderDrawerHead();
        return;
      case "rc":
        st.remote_control = st.remote_control || {};
        if (typeof ev.enabled === "boolean") st.remote_control.enabled = ev.enabled;
        if (ev.state) st.remote_control.state = ev.state;
        else if (ev.url) st.remote_control.state = "connected";
        renderDrawerHead();
        // The bridge reports several states on the way up; the log wants the
        // ones a person would care about, once each.
        var rcSay = ev.state === "connected" ? "connected" : typeof ev.enabled === "boolean" && !ev.enabled ? "off" : ev.state === "disconnected" || ev.state === "error" ? ev.state : null;
        if (rcSay && rcSay !== S.rcLast) {
          S.rcLast = rcSay;
          feedPush({ key: "rc" + ev.seq, ts: ev.ts, kind: rcSay === "connected" ? "info" : "warn", label: "remote", html: "<b>Remote Control</b> · " + esc(rcSay) }, replay);
        }
        return;
      case "status":
        return;
      default:
        // mission, decision, watcher, order, order_run, rule
        P.onEvent(type, ev, replay);
        return;
    }
  }

  function diffSessions(before, after, ts) {
    var was = {}, now = {};
    before.forEach(function (s) { was[s.pid] = s; });
    after.forEach(function (s) { now[s.pid] = s; });
    after.forEach(function (s) {
      if (s.self) return;
      if (!was[s.pid]) feedPush({ key: "s+" + s.pid, ts: ts, kind: "session", label: "session", html: "<b>" + esc(s.name || "A session") + "</b> started · " + esc(s.where || "") });
      else if (was[s.pid].status !== s.status && s.status === "waiting") feedPush({ key: "sw" + s.pid + ts, ts: ts, kind: "warn", label: "waiting", html: "<b>" + esc(s.name || "A session") + "</b> is waiting" + (s.waiting_for ? " for " + esc(s.waiting_for) : "") });
    });
    before.forEach(function (s) {
      if (!s.self && !now[s.pid]) feedPush({ key: "s-" + s.pid + ts, ts: ts, kind: "session", label: "session", html: "<b>" + esc(s.name || "A session") + "</b> ended" });
    });
  }
  function diffServices(before, after, ts) {
    var was = {};
    (before.failed || []).forEach(function (f) { was[f.unit] = 1; });
    (after.failed || []).forEach(function (f) {
      if (!was[f.unit]) feedPush({ key: "svc" + f.unit + (f.since || ts), ts: f.since || ts, kind: "error", label: "service", html: "<b>" + esc(f.unit) + "</b> failed" });
    });
  }

  var countsTimer = 0;
  function refreshCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(function () {
      api("status").then(function (st) {
        var keep = S.status && S.status.vitals;
        setStatus(st);
        if (!st.vitals && keep) st.vitals = keep;
        renderAll();
      }).catch(function () { /* next event will do */ });
    }, 400);
  }
  // Status is the source of truth for anything the events do not carry
  // (counts, queued turns, today's cost); a slow poll keeps it honest.
  setInterval(function () { if (!document.hidden && S.online) refreshCounts(); }, 30000);
  setInterval(function () { if (!document.hidden) renderSessions(true); }, 30000);

  /* ================================================================ voice: read-aloud
     Live conversation is the only way to talk to JOYA AI by voice (the live
     block below). This is the other half: a reply read aloud on request --
     its Read aloud (and JOYA AI's reply.read). Typed replies are no longer
     read aloud by themselves: the "Read replies aloud" switch (Settings ▸
     Voice and the speaker button here, its stored joya-read-aloud) was
     removed on 2026-10-30, at the administrator's request. Each
     sentence is read by OpenAI on the server (/joya-ai/api/speak, verbatim-
     checked), its audio streamed back and played from the first chunk, the
     next ones fetched while this one plays. With voice off, or without
     voice.use, none of its controls are on the page (READY is false) and
     nothing here speaks. The browser only ever talks to this panel. */

  var Voice = (function () {
    var api_ = {
      on: false, listening: false, speaking: false,
      say: function () {}, feed: function () {}, flush: function () {}, unlock: function () {}, tag: function () {}, stop: function () {},
    };
    // (Whether a live conversation holds the voice bar; false where the live block is absent, as in the tests' sandbox.)
    function liveOn() { return typeof liveActive === "function" && liveActive(); }
    var AC = window.AudioContext || window.webkitAudioContext;
    var AHEAD = 3; // sentences fetched ahead of the one playing
    var spoken = 0, queue = [], busy = false, gen = 0, clipAt = 0, lastSkipToast = 0;
    // What the voice did, for the console and for tests: window.__joyaVoice.
    // items: one record per sentence played -- when it was asked for, when its
    // first chunk arrived, when it started playing, when its stream ended.
    var diag = window.__joyaVoice = { fetched: 0, played: 0, playedSeconds: 0, skipped: 0, blocked: 0, cuts: 0, engines: [], said: [], items: [], cutAt: [] };

    function speakable(text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, " (code) ")
        .replace(/`[^`\n]+`/g, function (m) { return m.replace(/`/g, ""); })
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " a link ")
        .replace(/^\s*[#>]+\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/[*_~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    /* Where the reader is in a reply is counted in non-space characters, not
       string offsets: the reply changes shape as it streams (deltas first, then
       the finished blocks joined by blank lines), and an offset into one shape
       used on the other skipped or repeated words at every change. */
    function nonSpace(t) { return t.replace(/\s+/g, "").length; }
    function offsetAfter(text, n) {
      var i = 0, seen = 0;
      while (i < text.length && seen < n) { if (!/\s/.test(text.charAt(i))) seen++; i++; }
      return i;
    }
    /* Whole pieces ready to be read from `rest`. A sentence ends at . ! or ?
       followed by a space (so victim-ui.txt and 2.5 stay whole) or at a line
       end; never inside an unclosed ``` fence. The first piece of a reply may
       end at a clause (a comma, colon, semicolon or dash) so the voice starts
       sooner. */
    function pieces(rest, first) {
      var out = [], at = 0, re = /[.!?]+["')\]]*(?=\s)|\n/g, m;
      if (first) {
        var b = re.exec(rest), bEnd = b ? b.index + b[0].length : Infinity;
        var clause = /[,;:](?=\s)|\s[\u2013\u2014]\s/g, c;
        clause.lastIndex = 25;
        if ((c = clause.exec(rest)) && c.index + c[0].length < bEnd && !/```/.test(rest.slice(0, c.index))) {
          at = c.index + c[0].length;
          out.push(rest.slice(0, at).trim());
        }
      }
      re.lastIndex = at;
      while ((m = re.exec(rest))) {
        var end = m.index + m[0].length;
        if ((rest.slice(0, end).match(/```/g) || []).length % 2) continue;
        var piece = rest.slice(at, end).trim();
        at = end;
        if (piece) out.push(piece);
      }
      return { list: out, consumed: at };
    }
    Orb.micSource(function () { return liveOn() ? liveLevel("mic") : 0; });

    /* ---- the speaker: one AudioContext, an analyser in front of it, so the
       seed core pulses with the reply's real loudness ---- */
    var outCtx = null, outAn = null, outBuf = null, source = null;
    var heldBack = false; // eye contact: the reading paused while the person looks away (the context suspended)
    function outContext() {
      if (!AC) return null;
      if (!outCtx) {
        outCtx = new AC();
        outAn = outCtx.createAnalyser();
        outAn.fftSize = 512;
        outAn.connect(outCtx.destination);
        outBuf = new Uint8Array(outAn.fftSize);
      }
      if (!heldBack && outCtx.state === "suspended" && outCtx.resume) outCtx.resume().catch(function () { /* needs a gesture */ });
      return outCtx;
    }
    function outLevel() {
      if (liveOn()) return liveLevel("out");
      if (!api_.speaking) return -1;
      if (!source || !outAn) return 0;
      outAn.getByteTimeDomainData(outBuf);
      var sum = 0;
      for (var i = 0; i < outBuf.length; i++) { var v = (outBuf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / outBuf.length);
    }
    Orb.outSource(outLevel);
    /* core E's mouth: the same analyser's spectrum (the live call has its own, VoiceLive.spectrum); null: level only */
    var outSpec = { bins: null, hz: 0 };
    if (Orb.outSpectrum) Orb.outSpectrum(function () {
      if (liveOn()) return window.VoiceLive && window.VoiceLive.spectrum ? window.VoiceLive.spectrum() : null;
      if (!api_.speaking || !source || !outAn) return null;
      if (!outSpec.bins) { outSpec.bins = new Uint8Array(outAn.frequencyBinCount); outSpec.hz = outCtx.sampleRate / outAn.fftSize; }
      outAn.getByteFrequencyData(outSpec.bins);
      return outSpec;
    });

    function setUi() {
      paintState();
      renderRail();
    }

    /* ---- speaking, streamed: every sentence is a stream of PCM chunks that
       starts to play as soon as its first chunk arrives. The server reads the
       sentence (OpenAI, verbatim-checked while it streams) and sends
       start / audio / cut / end; a cut means that reading failed the check
       mid-way -- what plays of it stops at once, and the fallback's reading of
       the whole sentence follows in the same stream. Sentences are fetched a
       few ahead and play strictly in order; talking over them drops them all.
       Everything goes through one gain node per reading into the analyser, so
       the seed core pulses with the real output level. ---- */
    var RATE = 24000, PREBUF = 0.06, FADE = 0.012;
    var current = null; // the stream playing now: { stop() }

    function newStream(text, meta) {
      return { text: text, meta: meta || {}, chunks: [], ended: false, skipped: "", engine: "", cuts: 0, listener: null, ctrl: null,
        t: { asked: Date.now(), first: 0, end: 0, play: 0 } };
    }
    function pcmToFloat(b64) {
      var bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        out[i] = (v >= 32768 ? v - 65536 : v) / 32768;
      }
      return out;
    }
    function streamEvent(st, ev) {
      if (!st || st.ended) return;
      if (ev.type === "start") { st.engine = ev.engine || ""; if (ev.engine) diag.engines.push(ev.engine); }
      else if (ev.type === "audio" && ev.pcm) {
        if (!st.t.first) st.t.first = Date.now();
        try { st.chunks.push(pcmToFloat(ev.pcm)); } catch (e) { return; }
        if (st.listener) st.listener("audio");
      } else if (ev.type === "cut") {
        // The reading failed the verbatim check part-way: drop what is held
        // of it; if it is playing, the listener stops it now.
        st.cuts++;
        diag.cuts++;
        st.chunks = [];
        console.info("[voice] cut a reading that did not match the text (" + (ev.why || "unfaithful") + "); the fallback reads it again");
        if (st.listener) st.listener("cut");
      } else if (ev.type === "end" || ev.type === "skipped" || ev.type === "error") {
        st.ended = true;
        st.t.end = Date.now();
        if (ev.type === "skipped" || ev.skipped) st.skipped = ev.why || ev.skipped || "unfaithful";
        else if (ev.type === "error") st.skipped = ev.code || "error";
        if (st.listener) st.listener("end");
      }
    }
    function skippedNote(st) {
      diag.skipped++;
      if (st.skipped !== "unfaithful") return;
      console.warn("[voice] not read aloud (the voice would not read it as written):", st.text);
      var now = Date.now();
      if (now - lastSkipToast > 10000) { lastSkipToast = now; toast("One sentence was not read aloud. It is on the screen."); }
    }
    function readNdjson(r, onEvent) {
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
      function take(line) {
        if (!line.trim()) return;
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        onEvent(ev);
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.value) {
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
          }
          if (x.done) { take(buf); return; }
          return pump();
        });
      }
      return pump();
    }
    /* One POST per sentence, its audio streamed back. */
    function fetchClip(st) {
      var ctrl = window.AbortController ? new AbortController() : null;
      st.ctrl = ctrl;
      var body = { text: st.text };
      if (st.meta.vt) body.vt = st.meta.vt;
      if (st.meta.cat) body.cat = st.meta.cat;
      fetch("/joya-ai/api/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (j.code === "no-key") toast("Voice needs an OpenAI key. Add one in Settings ▸ Voice.", true);
            if (j.code === "voice-off") { toast("Voice is off. Replies are not read aloud.", true); READY = false; }
            streamEvent(st, { type: "error", code: j.code || "error" });
          });
        }
        diag.fetched++;
        return readNdjson(r, function (ev) { streamEvent(st, ev); });
      }).catch(function () { /* aborted, or the network */ }).then(function () {
        if (!st.ended) streamEvent(st, { type: "error", code: "network" });
      });
    }
    function prefetch() {
      for (var i = 0; i < queue.length && i < AHEAD; i++) {
        if (!queue[i].fetched) { queue[i].fetched = true; fetchClip(queue[i]); }
      }
    }
    function enqueue(piece, meta) {
      if (!READY) return;
      var say = speakable(piece);
      if (say.length < 2 || !/[a-z0-9]/i.test(say)) return;
      diag.said.push(say.slice(0, 780));
      queue.push(newStream(say.slice(0, 780), meta));
      prefetch();
      pump();
    }
    /* A browser may hold an AudioContext suspended until the page is clicked
       (autoplay rules). Then a clip "plays" into nothing: no error, no sound.
       So: resume before every clip, and if it stays suspended, say so and
       resume on the next click or key, when the waiting clip plays. */
    var unblockArmed = false;
    function blocked(c) {
      diag.blocked++;
      console.warn("[voice] the browser is holding sound back (AudioContext " + c.state + ")");
      if (unblockArmed) return;
      unblockArmed = true;
      toast("Your browser is holding JOYA's voice back. Click anywhere on the page to hear it.", true);
      var go = function () {
        unblockArmed = false;
        document.removeEventListener("pointerdown", go, true);
        document.removeEventListener("keydown", go, true);
        if (outCtx && outCtx.resume) outCtx.resume().catch(function () { /* still refused */ });
      };
      document.addEventListener("pointerdown", go, true);
      document.addEventListener("keydown", go, true);
    }
    /* Play one sentence's stream: schedule each chunk right after the one
       before it (a short lead on the first, and after any underrun), stop at
       once on a cut, resolve when the stream has ended and the last chunk has
       played. */
    function playStream(st, my) {
      return new Promise(function (resolve) {
        var c = outContext();
        if (!c) { resolve(); return; }
        if (!heldBack && c.state !== "running" && c.resume) c.resume().then(function () { if (c.state !== "running") blocked(c); }, function () { blocked(c); });
        var gain = null, gains = [], at = 0, live = [], started = false, finished = false, rec = null;
        function freshGain() { gain = c.createGain(); gain.connect(outAn); gains.push(gain); at = 0; }
        freshGain();
        function done() {
          if (finished) return;
          finished = true;
          st.listener = null;
          // Let any fade finish, then take this reading's gain nodes off the graph.
          setTimeout(function () { gains.forEach(function (g) { try { g.disconnect(); } catch (e) { /* gone */ } }); }, 200);
          if (current && current.st === st) current = null;
          resolve();
        }
        function stopLive(fade) {
          var t = c.currentTime;
          if (fade) {
            try { gain.gain.cancelScheduledValues(t); gain.gain.setValueAtTime(gain.gain.value, t); gain.gain.linearRampToValueAtTime(0, t + FADE); } catch (e) { /* closed */ }
          }
          live.forEach(function (s) { s.onended = null; try { s.stop(fade ? t + FADE + 0.003 : 0); } catch (e) { /* ended */ } });
          live = [];
          source = null;
        }
        function maybeDone() {
          if (!st.ended || live.length || st.chunks.length) return;
          if (!started || st.skipped) skippedNote(st);
          else { diag.played++; if (rec) rec.done = Date.now(); }
          done();
        }
        function drain() {
          if (my !== gen) { stopLive(true); return done(); }
          while (st.chunks.length) {
            var f = st.chunks.shift();
            if (!f.length) continue;
            var buf = c.createBuffer(1, f.length, RATE);
            buf.getChannelData(0).set(f);
            var s = c.createBufferSource();
            s.buffer = buf;
            s.connect(gain);
            var now = c.currentTime;
            if (at < now + 0.005) at = now + (started ? 0.02 : PREBUF);
            s.start(at);
            if (!started) {
              started = true;
              st.t.play = Date.now() + Math.round((at - now) * 1000);
              clipAt = st.t.play;
              rec = { text: st.text.slice(0, 80), engine: st.engine, asked: st.t.asked, first: st.t.first, sched: Date.now(), play: st.t.play, end: st.t.end || 0, cuts: 0 };
              diag.items.push(rec);
              // The caption shows this sentence as it is heard, word by word.
              if (api_.onSpeak) { var said = st.text; setTimeout(function () { if (my === gen) api_.onSpeak(said); }, Math.max(0, st.t.play - Date.now())); }
            }
            at += buf.duration;
            diag.playedSeconds += buf.duration;
            live.push(s);
            source = s;
            s.onended = (function (node) {
              return function () {
                var i = live.indexOf(node);
                if (i >= 0) live.splice(i, 1);
                if (!live.length) source = null;
                maybeDone();
              };
            })(s);
          }
          maybeDone();
        }
        current = { st: st, stop: function () { stopLive(true); done(); } };
        st.listener = function (kind) {
          if (my !== gen) { stopLive(true); return done(); }
          if (kind === "end" && rec) rec.end = st.t.end;
          if (kind === "cut") {
            // Stop the failed reading now; the fallback's chunks start afresh.
            if (rec) rec.cuts++;
            diag.cutAt.push({ text: st.text.slice(0, 80), at: Date.now(), playing: live.length > 0 });
            stopLive(true);
            freshGain();
          }
          drain();
        };
        drain();
      });
    }
    function pump() {
      if (busy || !queue.length) return;
      busy = true;
      api_.speaking = true;
      setUi();
      var item = queue.shift(), my = gen;
      prefetch();
      playStream(item, my).then(function () {
        if (my !== gen) return;
        busy = false;
        if (queue.length) return pump();
        api_.speaking = false;
        setUi();
        usageSoon();
      });
    }
    /** Stop speaking now: the stream playing, the ones fetched, the ones asked for. */
    function silence() {
      gen++;
      queue.forEach(function (q) { q.listener = null; if (q.ctrl) { try { q.ctrl.abort(); } catch (e) { /* done */ } } });
      queue = [];
      if (current) { var cur = current; current = null; cur.stop(); if (cur.st.ctrl) { try { cur.st.ctrl.abort(); } catch (e) { /* done */ } } }
      source = null;
      busy = false;
      api_.speaking = false;
    }
    /* The usage figures follow a voice turn, once its speech is done. */
    var usageTimer = 0;
    function usageSoon() {
      clearTimeout(usageTimer);
      usageTimer = setTimeout(function () { if (P && P.loadVoiceUsage) P.loadVoiceUsage(); }, 900);
    }

    // What each turn's speech is counted as: {vt, cat}, set by send().
    var tags = new Map();
    api_.tag = function (id, meta) { if (id != null && meta) tags.set(id, meta); };
    api_.unlock = function () { if (READY) outContext(); };
    api_.say = function (text) { if (READY) enqueue(text); };
    api_.stop = function () { if (heldBack) api_.pause(false); silence(); setUi(); };
    /* Eye contact: hold the reading where it is (the speaker's clock stops) / go on from there. */
    api_.pause = function (on) {
      on = !!on;
      if (on === heldBack || !outCtx) return false;
      heldBack = on;
      (on ? outCtx.suspend() : outCtx.resume()).catch(function () { /* gone */ });
      return true;
    };
    var spokenTurn = null;
    api_.feed = function (id, text) {
      text = String(text || "");
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var rest = text.slice(offsetAfter(text, spoken));
      var found = pieces(rest, spoken === 0);
      spoken += nonSpace(rest.slice(0, found.consumed));
      var meta = tags.get(id);
      found.list.forEach(function (p) { enqueue(p, meta); });
    };
    api_.flush = function (id, text) {
      text = String(text || "");
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var rest = text.slice(offsetAfter(text, spoken));
      var found = pieces(rest, spoken === 0);
      var meta = tags.get(id);
      found.list.forEach(function (p) { enqueue(p, meta); });
      var tail = rest.slice(found.consumed).trim();
      spoken = 0;
      spokenTurn = null;
      if (tail) enqueue(tail, meta);
    };
    return api_;
  })();

  /* ================================================================ LIVE CONVERSATION
     Integration block for public/voice-live.js, which holds all of the live
     logic (see its header and the README's integration contract). Live
     conversation is the only voice (2026-09-30): no push to talk, no
     hands-free, no front desk. This only:
       - starts and ends a call from the mic (the dock's too, and a link with
         ?call=1 -- the dock on another page comes here with it), the voice
         bar's End and close buttons, and mutes from its mute button;
       - while a call is on: Space mutes (or, in speakers mode while it speaks,
         interrupts), Esc only interrupts; nothing starts or ends on a key --
         only the red X ends a call (and never within 1.5 s of its start: a
         double click on the mic landed on the X, which sits in the same box);
       - a call that ends on its own says why (a toast with Reconnect); one the
         dashboard's restart ended comes back by itself, with backoff;
       - feeds the core and the caption: onState -> the state the core and the
         caption show (listening / thinking / speaking / delegating, with an
         "interrupted" flash on the voice bar), onCaption -> the caption's
         sentence, word by word, onLevel -> the core's amplitude. */
  var LIVE_OK = READY && root.getAttribute("data-voice-live") === "1" && !!(window.VoiceLive && window.VoiceLive.supported());
  var LIVE_DUPLEX_KEY = "joya-live-duplex";
  var LiveUI = { selected: LIVE_OK, active: false, state: "idle", caption: "", who: "", mic: 0, out: 0, duplex: root.getAttribute("data-live-duplex") === "full" ? "full" : "speakers" };
  try { var dxSaved = window.localStorage.getItem(LIVE_DUPLEX_KEY); if (dxSaved === "full" || dxSaved === "speakers") LiveUI.duplex = dxSaved; } catch (e) { /* storage blocked: the Settings default */ }
  var LIVE_TEXT = {
    connecting: "Connecting…", listening: "Listening — just talk", talking: "You're talking…", thinking: "Thinking…",
    speaking: "Speaking — talk over it to interrupt", speakingHalf: "Speaking — tap here to interrupt", interrupted: "Interrupted — go ahead", waiting: "Working on it — I'll tell you what I find",
    muted: "Muted — the microphone is off", ended: "Conversation ended", error: "The live conversation stopped", idle: "",
    reconnecting: "Reconnecting…",
  };
  var LIVE_END_GUARD_MS = 1500; // an end this soon after the start is a double click, not a hang-up
  // Why a call ended, for the toast (the server's `why`; "hung-up" is the administrator's own and says nothing).
  var LIVE_ENDED = {
    upstream: "The call dropped: the connection to OpenAI was lost.",
    "max-length": "The call reached its 20-minute limit.",
    "voice-command": "Stopped listening. The live conversation has ended.",
    "joya-ended": "Joya ended the call.",
    "signed-out": "The call ended: this device was signed out.",
    "settings-changed": "The call ended: the voice settings changed.",
    disabled: "The call ended: voice was switched off.",
    refused: "The call was stopped by the server.",
    restarting: "The dashboard restarted and the call could not come back.",
    closed: "The call dropped: the connection to the dashboard was lost.",
    "track-ended": "The call ended: the microphone went away.",
    devicechange: "The call ended: the microphone was disconnected.",
  };
  var LIVE_RETRY_MS = [1000, 2000, 4000, 8000, 15000]; // after a restart: the page comes back by itself
  var LIVE_TIP = "Start a live conversation";
  function liveSelected() { return !!(LiveUI && LiveUI.selected); }
  function paintLiveMode() {
    var mb = $("cc-mic-mode"), mic = $("cc-c-mic");
    if (mb) { mb.textContent = LIVE_OK ? "Live · " + (VOICE || "voice") : "Voice off"; mb.setAttribute("data-mode", LIVE_OK ? "live" : "off"); }
    if (mic) {
      mic.title = LiveUI.active ? "In a live conversation: click to mute or unmute (the red X ends it)" : LIVE_OK ? LIVE_TIP : "Voice is off: this browser can't hold a live conversation (no microphone access)";
      mic.setAttribute("aria-label", LiveUI.active ? "Mute or unmute the live conversation" : LIVE_OK ? LIVE_TIP : "Voice is off");
      if (!LIVE_OK && !mic.classList.contains("off")) {
        // Voice is on, but this browser can't do it: the off state, with the reason (never a dead grey button).
        mic.classList.add("off");
        mic.setAttribute("aria-disabled", "true");
        mic.innerHTML = ic("waveoff");
        $("cc-mic-why").textContent = mic.title;
        mic.setAttribute("aria-describedby", "cc-mic-why");
      }
    }
  }
  function paintLive(st) {
    LiveUI.state = st;
    var dock = $("cc-dock"), on = LiveUI.active;
    dock.classList.toggle("live-on", on);
    dock.classList.toggle("voice-on", on);
    dock.setAttribute("data-live", on ? st : "");
    if (!$("cc-c-mic")) return paintState(); // no voice on this page (off, or no voice.use)
    $("cc-c-mic").classList.toggle("live", on);
    $("cc-c-mic").setAttribute("aria-pressed", on ? "true" : "false");
    $("cc-live-acts").hidden = !on;
    $("cc-live-end").hidden = !on;
    var muted = on && st === "muted";
    var half = LiveUI.duplex !== "full", talkingOver = on && st === "speaking" && half;
    $("cc-live-mute").setAttribute("aria-pressed", muted ? "true" : "false");
    $("cc-live-mute").title = muted ? "Unmute the microphone" : talkingOver ? "Interrupt the voice (Space)" : "Mute the microphone (the conversation stays open)";
    var dx = $("cc-live-duplex");
    if (dx) {
      dx.setAttribute("data-duplex", half ? "speakers" : "full");
      $("cc-live-duplex-lbl").textContent = half ? "Speakers" : "Headphones";
      dx.title = half
        ? "Speakers mode: the microphone pauses while the voice speaks, so it cannot hear itself. Tap the bar, Space or Esc to interrupt. Click for headphones mode."
        : "Headphones mode: talk over the voice to interrupt it. Click for speakers mode (if it hears itself through laptop speakers).";
      dx.setAttribute("aria-label", (half ? "Speakers mode" : "Headphones mode") + ": switch to " + (half ? "headphones" : "speakers") + " mode");
    }
    paintLiveKeys();
    if (on) {
      var line = st === "connecting" && (LiveUI.wasReady || LiveUI.resuming) ? LIVE_TEXT.reconnecting : (st === "speaking" && half ? LIVE_TEXT.speakingHalf : LIVE_TEXT[st]) || st;
      // Hold-to-talk: "Listening" only while the key is held; between presses the call is just warm.
      if (LiveUI.ptt && (st === "listening" || st === "talking")) line = LiveUI.held ? (LiveUI.latched ? "Listening — pause to send" : "Listening — release to send") : "Hold " + talkKeyName() + " to talk";
      if (!(LiveUI.who === "you" && st === "thinking")) $("cc-vb-text").textContent = line;
    }
    paintState();
  }
  function liveStart(o) {
    o = o || {};
    if (LiveUI.active || !LIVE_OK) return;
    // A morning brief not read yet, and "read it aloud" on: read first, then the call (public/joya-proactive.js).
    if (!o.afterBrief && window.JoyaProactive && window.JoyaProactive.beforeLive && window.JoyaProactive.beforeLive(function () { o.afterBrief = true; liveStart(o); })) return;
    clearTimeout(LiveUI.retryT);
    liveEndedClose();
    LiveUI.active = true;
    LiveUI.who = "";
    LiveUI.startedAt = Date.now();
    LiveUI.wasReady = false;
    LiveUI.resuming = o.resume === "restart";
    LiveUI.ptt = !!o.ptt;
    Voice.stop(); // a reply being read aloud gives way to the call
    paintLive("connecting");
    paintLiveMode();
    window.VoiceLive.start({
      csrf: CSRF,
      tab: TAB_ID,
      duplex: LiveUI.duplex,
      resume: o.resume,
      lang: LiveUI.lang,
      // Hold-to-talk (the desktop app): the call's turns are the key's press and release, not voice detection.
      turn: o.ptt ? "ptt" : undefined,
      worklet: root.getAttribute("data-live-worklet") || undefined,
      onState: function (st) { if (LiveUI.active) paintLive(st); },
      onCaption: function (c) {
        LiveUI.who = c.who;
        if (c.who === "you" && c.text) LiveUI.lang = /[\u0600-\u06FF]/.test(c.text) ? "ar" : "en";
        LiveUI.caption = c.text;
        if (c.who === "you") $("cc-vb-text").textContent = c.text;
        if (DESKTOP) document.dispatchEvent(new CustomEvent("joya-live-caption", { detail: { who: c.who, text: c.text, final: c.final } }));
        paintState();
      },
      onLevel: function (l) { LiveUI.mic = l.mic || 0; LiveUI.out = l.out || 0; if (LiveUI.latched) latchVad(LiveUI.mic); },
      onEvent: function (m) {
        if (m.type === "replying" || m.type === "replied") callReply(m.turn);
        if (m.type === "ready") {
          screenSig = "";
          clearInterval(LiveUI.screenT);
          LiveUI.screenT = setInterval(screenTick, 1500);
          screenTick();
          LiveUI.model = m.model || ""; LiveUI.voice = m.voice || ""; LiveUI.route = window.VoiceLive.route ? window.VoiceLive.route() : "";
          LiveUI.wasReady = true; LiveUI.retry = 0;
          if (LiveUI.ptt) pttReady();
          if (LiveUI.resuming) toast("Reconnected.");
          LiveUI.resuming = false;
          paintLive(LiveUI.state);
        }
        // The upstream leg dropped and is being replaced; the voice says when it is back.
        if (m.type === "reconnecting") paintLive("connecting");
        if (m.type === "reconnected") toast("The line dropped for a second — reconnected.");
        if (m.type === "mic-lost") toast("The microphone went away — trying it again…", true);
        if (m.type === "mic-back") toast("The microphone is back.");
        if (m.type === "duplex" && (m.mode === "full" || m.mode === "speakers")) { LiveUI.duplex = m.mode; paintLive(LiveUI.state); }
        if (m.type === "suggest" && m.mode === "speakers" && LiveUI.duplex === "full") liveSuggest();
        if (m.type === "ui") {
          // A screen action the voice asked for (public/ui-actions.js); the server waits for this answer.
          var res = runUiAction(m);
          if (m.nonce) window.VoiceLive.ack(m.nonce, res.ok, res.why);
        }
        if (m.type === "ui-undo") uiUndoNow("voice"); // "undo" said in the call, caught by the server
        // The voiceprint's verdict on the turn just heard: on the state pill, never spoken, no score.
        if (m.type === "voiceprint") showVoiceprint(m);
        // The voice settings changed and the call reconnected with them (the voice is global).
        if (m.type === "voice-changed") {
          var vt = $("cc-voice-tag"); if (vt && m.voice) vt.textContent = m.voice;
          if (!m.greet) toast("The voice was changed" + (m.voice ? " to " + m.voice : "") + ".");
        }
        if (m.type === "ui-confirmed" || m.type === "ui-confirm-cancelled") uiConfirmAnswer(m.id, m.type === "ui-confirmed");
        if (m.type === "ui-confirm-expired") uiConfirmExpired(m.id, null);
        if (m.type === "ended" || m.type === "error") liveEnded(m);
      },
    }).catch(function (e) {
      // Could not start (refused, OpenAI unreachable, no microphone): said, never silent.
      liveEnded({ type: "error", why: "start", error: (e && e.message) || "could not start" });
    });
  }
  /**
   * The call is over. Why is shown (a toast with Reconnect) unless the
   * administrator ended it themselves; one the dashboard's restart ended
   * comes back by itself (LIVE_RETRY_MS), the voice saying it is back.
   */
  function liveEnded(m) {
    if (!LiveUI.active) return;
    vpShown = null; // a verdict belongs to its call
    m = m || {};
    var resuming = LiveUI.resuming, warmOnly = LiveUI.warmOnly;
    LiveUI.active = false;
    LiveUI.warmOnly = false;
    LiveUI.lookTurn = false;
    LiveUI.caption = "";
    LiveUI.ptt = false;
    LiveUI.held = false;
    LiveUI.latched = false;
    LiveUI.skipUp = false;
    clearTimeout(LiveUI.latchT);
    clearInterval(LiveUI.paintT);
    clearInterval(LiveUI.screenT);
    clearTimeout(LiveUI.warmT);
    LiveUI.resuming = false;
    paintLive("idle");
    paintLiveMode();
    var why = m.why || (m.type === "error" ? "error" : "ended");
    if (why === "hung-up") return;
    // a call eye contact opened ahead (nobody has talked yet) goes quietly; a turn would say what went wrong
    if (warmOnly) return;
    if (why === "restarting" || resuming) return liveRetry(); // (a failed try while coming back: the next one)
    if (m.type === "error" && m.code === "busy") return toast(m.error, true);
    var text = LIVE_ENDED[why] || (m.type === "error" ? "The live conversation could not start" + (m.error ? ": " + m.error : ".") : "The live conversation ended.");
    if (why === "upstream" && m.text) text = "The call dropped: " + m.text.replace(/^The /, "the ");
    else if (m.text && !LIVE_ENDED[why]) text = m.text;
    liveEndedToast(text, why !== "voice-command" && why !== "joya-ended");
  }
  /** After a restart: try again, with backoff; after the last try, say so (with Reconnect). */
  function liveRetry() {
    var n = LiveUI.retry || 0;
    if (n >= LIVE_RETRY_MS.length) { LiveUI.retry = 0; return liveEndedToast(LIVE_ENDED.restarting, true); }
    LiveUI.retry = n + 1;
    toast("The dashboard is restarting — reconnecting the call…");
    clearTimeout(LiveUI.retryT);
    LiveUI.retryT = setTimeout(function () { if (!LiveUI.active) liveStart({ resume: "restart" }); }, LIVE_RETRY_MS[n] + Math.round(Math.random() * 400));
  }
  /** Why the call ended, with Reconnect: on the Command Center, or on the dock while a page is up. */
  function liveEndedToast(text, bad) {
    liveEndedClose();
    var again = function () { liveEndedClose(); liveStart(); };
    if (shellUp() && window.__joyaDock && window.__joyaDock.toast) return window.__joyaDock.toast(text, { bad: !!bad, action: { label: "Reconnect", fn: again } });
    var old = document.querySelector(".cc-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "cc-toast cc-live-ended" + (bad ? " bad" : "");
    el.setAttribute("role", "status");
    var t = document.createElement("span");
    t.textContent = text;
    el.appendChild(t);
    if (LIVE_OK) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "cc-btn sm";
      b.setAttribute("data-live-reconnect", "");
      b.textContent = "Reconnect";
      b.addEventListener("click", again);
      el.appendChild(b);
    }
    document.body.appendChild(el);
    LiveUI.endedT = setTimeout(liveEndedClose, 12000);
  }
  function liveEndedClose() {
    clearTimeout(LiveUI.endedT);
    var el = document.querySelector(".cc-live-ended");
    if (el) el.remove();
  }
  /** Hang up: only the red X (why "button"), leaving the page, or a lost microphone. Not within 1.5 s of the start. */
  function liveStop(why) {
    why = why || "button";
    if (why === "button" && LiveUI.active && Date.now() - (LiveUI.startedAt || 0) < LIVE_END_GUARD_MS) return false;
    clearTimeout(LiveUI.retryT);
    LiveUI.retry = 0;
    if (window.VoiceLive) window.VoiceLive.stop(why);
    liveEnded({ why: "hung-up" });
    liveSuggestClose();
    return true;
  }
  /** The mic while a call is on: mute and unmute it, everywhere (it never ends the call). */
  function liveMuteToggle() {
    if (!LiveUI.active || !window.VoiceLive) return;
    window.VoiceLive.mute(!window.VoiceLive.muted());
  }
  /** Speakers or headphones, for this browser (the Settings value is only the default). */
  function liveDuplex(mode) {
    LiveUI.duplex = mode === "full" ? "full" : "speakers";
    try { window.localStorage.setItem(LIVE_DUPLEX_KEY, LiveUI.duplex); } catch (e) { /* not remembered */ }
    if (LiveUI.active && window.VoiceLive.duplex) window.VoiceLive.duplex(LiveUI.duplex);
    liveSuggestClose();
    paintLive(LiveUI.state);
  }
  /** The voice is hearing itself: offer speakers mode, without blocking anything. */
  function liveSuggest() {
    liveSuggestClose();
    var el = document.createElement("div");
    el.className = "cc-toast cc-live-suggest";
    el.setAttribute("role", "status");
    el.innerHTML = '<span>The voice seems to hear itself through the speakers.</span> <button type="button" class="cc-btn sm" data-live-suggest="speakers">Use speakers mode</button> <button type="button" class="cc-ibtn" data-live-suggest="no" aria-label="Dismiss" title="Dismiss">✕</button>';
    document.body.appendChild(el);
    LiveUI.suggestT = setTimeout(liveSuggestClose, 15000);
  }
  function liveSuggestClose() {
    clearTimeout(LiveUI.suggestT);
    var el = document.querySelector(".cc-live-suggest");
    if (el) el.remove();
  }
  /** The desktop app's talk key, as its settings name it ("Ctrl+Space"). */
  function talkKeyName() {
    var d = window.JoyaDesktop && window.JoyaDesktop.state ? window.JoyaDesktop.state() : null;
    return (d && d.talkKey) || "Ctrl+Space";
  }
  var MIC_WHY = { off: "starting the call", asking: "waiting for the microphone", resting: "opening the microphone", refused: "the microphone was refused", ended: "the microphone went away", muted: "Windows has the microphone muted",
    "audio suspended": "the browser paused audio", "audio closed": "audio is closed", "no audio": "no sound from the microphone", "muted here": "muted — unmute to talk" };
  function liveSpeaking() { return LiveUI.active && window.VoiceLive.speaking && window.VoiceLive.speaking(); }
  /** What the core and the caption show while a call is on (see snapshot()). */
  function liveSnapshot(snap) {
    if (!liveActive()) return snap;
    var st = LiveUI.state;
    snap.listening = st === "listening" || st === "talking" || st === "interrupted" || st === "connecting";
    // Hold-to-talk: the core listens only while the key is held; between turns the call is just warm.
    if (LiveUI.ptt) snap.listening = !!LiveUI.held || st === "talking";
    // ...and only while the microphone's audio really flows: otherwise the pill says so, and why.
    if (LiveUI.ptt && LiveUI.held && window.VoiceLive.micState) {
      var ms = window.VoiceLive.micState();
      if (!ms.ok) { snap.listening = false; snap.micNotReady = MIC_WHY[ms.why] || ms.why || "starting"; }
    }
    // Warm (the key up, nothing being answered or said): ready to talk, with the key to hold.
    if (LiveUI.ptt && !LiveUI.held && (st === "listening" || st === "talking")) snap.pttWarm = "Hold " + talkKeyName() + " to talk";
    snap.speaking = st === "speaking";
    snap.voiceLive = st === "thinking";
    snap.voiceText = $("cc-vb-text").textContent;
    snap.spoken = st === "speaking" && LiveUI.who !== "you" ? LiveUI.caption : "";
    if (st === "waiting") { snap.delegatingTo = "JOYA AI"; snap.delegation = "Working on it — I'll tell you what I find."; }
    return snap;
  }
  // The mic starts and ends a call; the voice bar belongs to the call while one is on.
  window.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    // The mic while voice is off: it says why, in words, where the hint row is (with the way to switch it on).
    var off = e.target.closest(".cc-c-mic.off");
    if (off) { e.stopPropagation(); e.preventDefault(); return micOffSay(off.title); }
    // The desktop app: a mic held down was a hold-to-talk turn, not a tap.
    if (DESKTOP && pttMic.swallow && e.target.closest("#cc-c-mic")) { pttMic.swallow = false; e.stopPropagation(); e.preventDefault(); return; }
    // The mic starts a call; during one it mutes (only the red X ends it).
    if (LIVE_OK && e.target.closest("#cc-c-mic")) { e.stopPropagation(); e.preventDefault(); return LiveUI.active ? liveMuteToggle() : liveStart(); }
    if (LiveUI.active && e.target.closest("#cc-live-end")) { e.stopPropagation(); return liveStop("button"); }
    if (LiveUI.active && e.target.closest("#cc-vb-close")) { e.stopPropagation(); return; }
    var sg = e.target.closest("[data-live-suggest]");
    if (sg) { e.stopPropagation(); return sg.getAttribute("data-live-suggest") === "speakers" ? liveDuplex("speakers") : liveSuggestClose(); }
    if (LiveUI.active && e.target.closest("#cc-live-duplex")) { e.stopPropagation(); return liveDuplex(LiveUI.duplex === "full" ? "speakers" : "full"); }
    if (LiveUI.active && e.target.closest("#cc-live-mute")) {
      e.stopPropagation();
      if (LiveUI.duplex !== "full" && liveSpeaking()) return window.VoiceLive.interrupt();
      return liveMuteToggle();
    }
    // A tap on the bar's text while the voice speaks interrupts it.
    if (LiveUI.active && e.target.closest(".cc-dock.live-on .cc-vb-text") && liveSpeaking()) { e.stopPropagation(); return window.VoiceLive.interrupt(); }
  }, true);
  // Keys while a call is on: Space mutes and unmutes it (in speakers mode, while the voice
  // speaks, it interrupts); Esc interrupts the voice and nothing else (when nothing else is open
  // for Esc to close). No key starts or ends a call: the mic starts it, the red X ends it.
  window.addEventListener("keydown", function (e) {
    if (!LiveUI.active || e.repeat || liveTyping(document.activeElement)) return;
    if (e.code === "Space") {
      e.stopPropagation();
      e.preventDefault();
      if (LiveUI.duplex !== "full" && liveSpeaking()) window.VoiceLive.interrupt();
      else window.VoiceLive.mute(!window.VoiceLive.muted());
    } else if (e.key === "Escape" && LiveUI.active && $("cc-pop").hidden && $("cc-reply").hidden && !document.querySelector(".cc-sheet.open") && !document.querySelector(".cc-need:not([hidden])")) {
      e.stopPropagation();
      if (liveSpeaking()) window.VoiceLive.interrupt();
    }
  }, true);
  window.addEventListener("keyup", function (e) { if (LiveUI.active && e.code === "Space" && !liveTyping(document.activeElement)) e.stopPropagation(); }, true);
  /** The hint under the pill: "click the mic to talk", then what Space and Esc do in a call. */
  function paintLiveKeys() {
    var lk = $("cc-kb-live");
    if (!lk) return;
    lk.hidden = !LiveUI.active;
    var speaking = LiveUI.active && LiveUI.state === "speaking";
    lk.innerHTML = speaking && LiveUI.duplex !== "full" ? "<kbd>Space</kbd> or <kbd>Esc</kbd> interrupt"
      : "<kbd>Space</kbd> mute · <kbd>Esc</kbd> interrupt";
  }
  function micOffSay(why) {
    var h = $("cc-hint");
    hint(why || "Voice is off.", false);
    if (root.getAttribute("data-voice-manage") === "1" && /Settings/.test(why || "")) {
      h.textContent = "";
      var t = document.createElement("span");
      t.textContent = String(why).replace(/:.*$/, "") + ": ";
      var a = document.createElement("a");
      a.href = "/joya-ai/settings/voice";
      a.textContent = String(why).replace(/^[^:]*:\s*/, "").replace(/^./, function (c) { return c.toUpperCase(); });
      h.appendChild(t);
      h.appendChild(a);
    }
    announce(why || "Voice is off.");
    clearTimeout(micOffSay.t);
    micOffSay.t = setTimeout(function () { hint(""); }, 8000);
  }
  function liveTyping(el) { return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.tagName === "BUTTON"); }
  // Leaving the page ends the call, and says so (the socket's last message, and a beacon).
  window.addEventListener("pagehide", function () { if (LiveUI.active) window.VoiceLive.stop("unload"); });
  window.addEventListener("beforeunload", function () { if (LiveUI.active) window.VoiceLive.stop("unload"); });
  paintLiveMode();
  paintLiveKeys();
  /* The dock on another page starts a call by coming here with ?call=1 (and ?at=<that page>,
     which the shell keeps showing): the call starts once, and the flag leaves the address. */
  (function () {
    var q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (q.get("call") !== "1") return;
    q.delete("call");
    var rest = q.toString();
    try { history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash); } catch (e) { /* the address keeps it; harmless */ }
    if (!LIVE_OK) return toast(READY ? "Live conversation is not supported in this browser." : "Voice is off.", true);
    setTimeout(liveStart, 0);
  })();
  /** For the dock (joya-dock.js in the shell): the mic there is this one. */
  // toggle(): the dock's mic -- it starts a call, and during one it mutes (it never ends it).
  window.__joyaLive = { ok: function () { return LIVE_OK; }, active: function () { return LiveUI.active; }, toggle: function () { if (!LIVE_OK) return false; if (LiveUI.active) liveMuteToggle(); else liveStart(); return true; }, end: function (why) { return liveStop(why || "button"); },
    // Hold-to-talk (the desktop app's key, or holding the mic there): down / up.
    // at / seq: the app's own time of the key event (ms since 1970) and its order; see pttKey.
    ptt: function (down, at, seq) { return pttKey(!!down, at, seq); }, held: function () { return !!LiveUI.held; },
    latched: function () { return !!LiveUI.latched; },
    // "live" (hands-free), "ptt" (hold-to-talk, warm or held) or "" (no call): the desktop page's live button.
    mode: function () { return LiveUI.active ? (LiveUI.ptt ? "ptt" : "live") : ""; },
    // Eye contact's "look and speak" (joya-presence.js): you faced JOYA AI and started talking -- a turn opens as a
    // tap of the talk key does (latched: it is sent after a pause, or by the key), on the same hold-to-talk path.
    // o.preroll (2026-10-21): the audio from just before the speech began, so the turn has its first words; the
    // turn ends after LOOK_QUIET_MS of quiet (a tap's latch waits LATCH_QUIET_MS).
    lookTalk: function (o) {
      if (!LIVE_OK || LiveUI.held || LiveUI.latched || (LiveUI.active && !LiveUI.ptt) || liveSpeaking()) return false;
      if (!pttPress(false, undefined, o && o.preroll ? { preroll: o.preroll } : null)) return false;
      LiveUI.lookTurn = true;
      LiveUI.latched = true;
      LiveUI.lv = null;
      LiveUI.latchT = setTimeout(pttSend, PTT_LATCH_MS);
      if (LiveUI.state) paintLive(LiveUI.state);
      paintState();
      return true;
    },
    // Eye contact: the look armed look and speak -- the call opens now (hold-to-talk, warm), so a turn that follows
    // does not wait for it; unused, it hangs up after LOOK_WARM_MS. Never over a reply being read, never the brief.
    lookWarm: function () {
      if (!LIVE_OK || LiveUI.active || !window.VoiceLive || (typeof Voice !== "undefined" && Voice.speaking)) return false;
      LiveUI.warmOnly = true;
      liveStart({ ptt: true, afterBrief: true });
      if (!LiveUI.active) { LiveUI.warmOnly = false; return false; }
      return true;
    },
    busy: function () { return !!(LiveUI.held || LiveUI.latched || liveSpeaking() || LiveUI.state === "thinking" || LiveUI.state === "waiting" || (LiveUI.active && !LiveUI.ptt)); },
    // The microphone's level (0..1) while a call is on: the desktop page's state pill shows it.
    level: function () { return LiveUI.active ? LiveUI.mic || 0 : 0; } };
  /*
   * Hold-to-talk, for the desktop app (DESIGN.md, "Voice"). The first press
   * opens a live call in its "ptt" turn mode (the server commits a turn when
   * the key comes up, instead of detecting speech); the call then stays warm
   * for PTT_WARM_MS after the last release, so a follow-up starts at once, and
   * hangs up by itself after that. A press while the voice speaks interrupts
   * it. A hands-free call (the mic tapped) is never turned into one.
   */
  var PTT_WARM_MS = 60 * 1000;
  // A call eye contact opened ahead of a turn (lookWarm) that nobody talked into hangs up after this.
  var LOOK_WARM_MS = 20 * 1000;
  // The desktop app's mic: held for PTT_HOLD_MS it is hold-to-talk; a tap is a hands-free call, as on the web.
  var PTT_HOLD_MS = 280;
  var pttMic = { t: 0, on: false, swallow: false };
  if (DESKTOP) {
    window.addEventListener("pointerdown", function (e) {
      if (!LIVE_OK || e.button !== 0 || !e.target.closest || !e.target.closest("#cc-c-mic") || (LiveUI.active && !LiveUI.ptt)) return;
      clearTimeout(pttMic.t);
      pttMic.on = false;
      pttMic.t = setTimeout(function () { pttMic.on = true; pttPress(); }, PTT_HOLD_MS);
    }, true);
    var micUp = function () {
      clearTimeout(pttMic.t);
      if (pttMic.on) { pttMic.on = false; pttMic.swallow = true; pttRelease(); setTimeout(function () { pttMic.swallow = false; }, 400); }
    };
    window.addEventListener("pointerup", micUp, true);
    window.addEventListener("pointercancel", micUp, true);
  }
  /*
   * The key: held, it is hold-to-talk. Tapped (up again within PTT_TAP_MS), it
   * latches: JOYA AI keeps listening until the next press, which sends the turn
   * (at most PTT_LATCH_MS). A tap is also what a hotkey that reports its release
   * at once looks like, so the key works either way.
   */
  var PTT_TAP_MS = 300;
  var PTT_LATCH_MS = 30 * 1000;
  // A latched turn is sent by itself after this much quiet, once something was said (latchVad).
  var LATCH_QUIET_MS = 1200, LATCH_SPOKEN_MS = 300;
  // A look-and-speak turn ends sooner (2026-10-21, "slow"): 700 ms of quiet after speech -- longer than the pause
  // between words or a breath mid-sentence, short enough not to wait on the person.
  // But not after only a word or two (2026-10-22: a look-and-speak turn of ~1.6 s reached JOYA AI as one word,
  // and the request itself came in the next turn): an Egyptian "يعني..." or "Claude, ..." pause after the first
  // words is longer than 700 ms, so until LOOK_SHORT_SPOKEN_MS has been said the turn waits LOOK_QUIET_SHORT_MS.
  var LOOK_QUIET_MS = 700, LOOK_QUIET_SHORT_MS = 1100, LOOK_SHORT_SPOKEN_MS = 1500;
  var keySeq = 0;
  /*
   * The app's key events, in its own order and with its own clock: a tap is
   * judged by when the key really went down and up (WebView2 may hand the two
   * events over late and together), an event older than one already seen is
   * dropped, and a second "down" with no "up" between (an up that was lost)
   * ends the turn instead of being ignored -- a held turn can never get stuck.
   */
  function pttKey(down, at, seq) {
    if (typeof seq === "number") {
      if (seq <= keySeq) { if (window.VoiceLive.note) window.VoiceLive.note({ k: "stale", at: at, seq: seq }); return false; }
      keySeq = seq;
    }
    var t = typeof at === "number" && isFinite(at) ? at : Date.now();
    var r = down ? pttPress(true, t) : pttRelease(true, t);
    if (window.VoiceLive.note) window.VoiceLive.note({ k: down ? "down" : "up", at: t, seq: seq });
    return r;
  }
  function pttPress(key, at, o) {
    if (!LIVE_OK) return false;
    if (LiveUI.latched) { LiveUI.skipUp = true; pttSend(); return true; } // the press that sends a latched turn
    if (LiveUI.held) {
      // The key went down again with no "up" seen: that up was lost. This press ends the turn.
      if (key && LiveUI.byKey) { LiveUI.skipUp = true; pttSend(); }
      return true;
    }
    LiveUI.held = true;
    LiveUI.warmOnly = false;
    LiveUI.lookTurn = false;
    LiveUI.pressAt = at || Date.now();
    LiveUI.byKey = !!key;
    clearTimeout(LiveUI.warmT);
    if (!LiveUI.active) liveStart({ ptt: true });
    else if (!LiveUI.ptt) { if (liveSpeaking()) window.VoiceLive.interrupt(); LiveUI.held = false; return false; }
    // Pressed at once, even while the call is still opening: voice-live.js keeps what is said until it is ready.
    // (o.preroll: look and speak's audio from just before the speech began; sent first)
    if (LiveUI.active && window.VoiceLive.press) window.VoiceLive.press(o || undefined);
    // While the key is held the pill follows the microphone (Listening, or Mic not ready and why).
    clearInterval(LiveUI.paintT);
    LiveUI.paintT = setInterval(paintState, 250);
    if (LiveUI.state) paintLive(LiveUI.state);
    paintState();
    return true;
  }
  function pttRelease(key, at) {
    if (key && LiveUI.skipUp) { LiveUI.skipUp = false; return false; }
    if (!LiveUI.held || LiveUI.latched) return false;
    if (key && LiveUI.byKey && (at || Date.now()) - (LiveUI.pressAt || 0) < PTT_TAP_MS) {
      LiveUI.latched = true;
      LiveUI.lv = null;
      LiveUI.latchT = setTimeout(pttSend, PTT_LATCH_MS);
      toast("Listening — speak, then pause to send (or press the talk key again).");
      if (LiveUI.state) paintLive(LiveUI.state);
      paintState();
      return true;
    }
    pttSend();
    return true;
  }
  /*
   * Latched (a tap): the turn ends by itself after LATCH_QUIET_MS of quiet once
   * the person has spoken for LATCH_SPOKEN_MS -- the microphone's level against
   * a floor that follows the room's noise. No key-up needed.
   */
  function latchVad(level) {
    var now = Date.now();
    var v = LiveUI.lv || (LiveUI.lv = { floor: 0.004, spoken: 0, quietAt: 0, last: now });
    var dt = Math.min(100, Math.max(0, now - v.last));
    v.last = now;
    if (level < v.floor * 3) v.floor = Math.max(0.001, v.floor * 0.97 + level * 0.03);
    if (level > Math.max(0.012, v.floor * 4)) { v.spoken += dt; v.quietAt = 0; }
    else if (!v.quietAt) v.quietAt = now;
    var quietMs = LiveUI.lookTurn ? (v.spoken < LOOK_SHORT_SPOKEN_MS ? LOOK_QUIET_SHORT_MS : LOOK_QUIET_MS) : LATCH_QUIET_MS;
    if (v.spoken >= LATCH_SPOKEN_MS && v.quietAt && now - v.quietAt >= quietMs) pttSend();
  }
  /** The turn is over: the server commits it (voice-live.js release). */
  function pttSend() {
    clearTimeout(LiveUI.latchT);
    clearInterval(LiveUI.paintT);
    LiveUI.latched = false;
    LiveUI.lookTurn = false;
    LiveUI.lv = null;
    if (!LiveUI.held) return;
    LiveUI.held = false;
    if (LiveUI.active && LiveUI.ptt && window.VoiceLive.release) window.VoiceLive.release();
    if (window.VoiceLive.note) window.VoiceLive.note({ k: "send" });
    pttWarm();
    if (LiveUI.active && LiveUI.state) paintLive(LiveUI.state);
    paintState();
  }
  /** The call is ready (the press was made when the key went down): with the key up already, the warm spell starts. */
  function pttReady() { if (!LiveUI.held) pttWarm(); }
  function pttWarm() {
    clearTimeout(LiveUI.warmT);
    LiveUI.warmT = setTimeout(function warm() {
      // opened ahead by eye contact and never talked into: it goes after LOOK_WARM_MS
      if (LiveUI.warmOnly && LiveUI.active && !LiveUI.held) { LiveUI.warmOnly = false; liveStop("ptt-idle"); return; }
      if (!LiveUI.active || !LiveUI.ptt) return;
      // Still answering, or the voice still speaking: wait for it to finish, then the full spell.
      if (LiveUI.held || liveSpeaking() || LiveUI.state === "thinking" || LiveUI.state === "waiting") { LiveUI.warmT = setTimeout(warm, 5000); return; }
      liveStop("ptt-idle");
    }, LiveUI.warmOnly ? LOOK_WARM_MS : PTT_WARM_MS);
  }
  /* ---------------------------------------------------------- screen actions
     What JOYA AI's voice may change on this screen (UI control Phase 1): the
     shared allowlist public/ui-actions.js, checked again here, run through
     the same functions the buttons and the palette use, and always shown
     with a toast ("Joya opened Missions") and an Undo where it makes sense.
     Nothing here can press Approve, touch settings values or unmute. */
  var uiSeen = {};
  function runUiAction(ev) {
    var UA = window.UiActions;
    // The page map this viewer's JOYA AI may open (lib/page-map.js), checked again here.
    try { if (UA && UA.setPages) UA.setPages(JSON.parse($("cc").getAttribute("data-page-map") || "null")); } catch (e) { /* the built-in pages stay */ }
    if (!UA || !ev) return { ok: false, why: "this page has no screen actions" };
    if (ev.nonce) {
      if (uiSeen[ev.nonce]) return { ok: false, why: "already done" };
      uiSeen[ev.nonce] = 1;
    }
    var v = UA.validate(ev.action, ev.args);
    if (!v.ok) return v;
    // Voice is off (or not this viewer's): the call and the voice cannot be touched from here.
    if ((/^call\./.test(v.action) || v.action === "voice.set") && !READY) return { ok: false, why: "voice is off" };
    // Another page is up in the shell: anything but the call, page.open and a Tier-2 ask (its Confirm /
    // Cancel show in the dock) is done here, so come back first.
    if (shellUp() && v.tier !== 2 && ["call.end", "call.mute", "call.interrupt", "page.open"].indexOf(v.action) < 0) window.JoyaShell.expand();
    if (v.tier === 2) return uiConfirmAsk(ev, v);
    var a = v.args, undo = null, link = null;
    try {
      switch (v.action) {
        case "call.end": break; // the server ends it after the goodbye; the tab follows
        case "call.interrupt": break;
        case "call.mute": if (LiveUI.active && window.VoiceLive && !window.VoiceLive.muted()) window.VoiceLive.mute(true); break;
        case "sheet.open": { var wasP = S.pane; openSheet(a.key); undo = function () { if (wasP) openSheet(wasP); else closeSheet(); }; break; }
        case "sheet.close": {
          var wasC = S.pane;
          if (!wasC) return { ok: false, why: "no panel is open" };
          if (a.key && a.key !== wasC && a.key !== "everything") return { ok: false, why: "that panel is not the one open" };
          closeSheet(); undo = function () { openSheet(wasC); }; break;
        }
        case "view": { var wasV = S.pane; P.setView(a.name); undo = function () { if (wasV) openSheet(wasV); else closeSheet(); }; break; }
        case "core.set": { var wasK = coreNow(); setCoreChoice(a.core); undo = function () { setCoreChoice(wasK); }; break; }
        case "reply.show": if (!lastReplyTurn()) return { ok: false, why: "there is no reply yet" }; openReply(); undo = closeReply; break;
        case "reply.read": if (!lastReplyTurn()) return { ok: false, why: "there is no reply yet" }; if (!$("cc-reply-read")) return { ok: false, why: "voice is off" }; $("cc-reply-read").click(); break;
        case "decision.show": if (!needQueue().length) return { ok: false, why: "no card is waiting" }; openNeed(); break;
        case "settings.open": link = UA.pageUrl(a.page); break; // a link to click: never navigates by itself (a call would end)
        case "page.open": {
          // Another page of Joya (M-5): only one this viewer's role may see (the server listed them in data-pages).
          var np = UA.navPage(a.page);
          // The Command Center itself or one of its sheets (the page map's "cc" and "cc.<sheet>", /joya-ai#<sheet>;
          // validate() already turned the old "command-center" into "cc"): shown right here, never a navigation.
          var cc = ccTarget(np && np.url);
          if (cc) {
            var wasUp = shellUp();
            if (wasUp) window.JoyaShell.expand();
            if (cc.sheet && SHEET_KEYS.indexOf(cc.sheet) >= 0) { var wasS = S.pane; openSheet(cc.sheet); undo = function () { if (wasS) openSheet(wasS); else closeSheet(); }; break; }
            if (!wasUp) { uiToast("You are on the Command Center", null, null); return { ok: true }; }
            break;
          }
          if ((" " + (root.getAttribute("data-pages") || "") + " ").indexOf(" " + a.page + " ") < 0) return { ok: false, why: "their role cannot open " + np.label + " (it needs " + np.perm + ")" };
          // The shell (M-5 part 2): the page opens in its frame at once and a live call goes on;
          // Undo is the browser's back. Without it, the old way: the whole tab moves after the sentence
          // -- but never while a call is on (pageOpenSoon).
          if (window.JoyaShell && window.JoyaShell.open(np.url)) { undo = function () { window.JoyaShell.back(); }; break; }
          if (!pageOpenSoon(a.page, np)) return { ok: false, why: "that page cannot open during a live call from here; a link to it is on screen" };
          break;
        }
        default: return { ok: false, why: "not on this page" };
      }
    } catch (e) {
      return { ok: false, why: "it did not work here: " + ((e && e.message) || e) };
    }
    uiToast(ev.toast || UA.toast(v.action, a), undo, link);
    return { ok: true };
  }
  /* The most recent screen action's undo, while its toast offers it: the
     toast's button and a spoken "undo" (voice-stop.js undo()) both come here.
     Any newer screen action replaces it; one without an undo clears it. */
  var UI_UNDO_MS = 15000;
  var uiUndoState = null;
  function uiUndoable() { return !!(uiUndoState && Date.now() < uiUndoState.until); }
  function uiUndoSignal(ms) { if (window.VoiceLive && window.VoiceLive.undoable && liveActive()) window.VoiceLive.undoable(ms); }
  function uiUndoNow(how) {
    if (!uiUndoable()) { uiUndoState = null; return false; }
    var u = uiUndoState;
    uiUndoState = null;
    try { u.fn(); } catch (e) { /* nothing to undo */ }
    if (u.el) u.el.remove();
    uiUndoSignal(0);
    if (how === "voice") toast("Undone.");
    return true;
  }
  /** A page-map url that is the Command Center (or one of its sheets): { sheet } or null. */
  function ccTarget(url) {
    var u = String(url || "");
    if (!/^\/joya-ai\/?(?:[?#]|$)/.test(u)) return null;
    var m = /#([a-z0-9_-]+)$/.exec(u);
    return { sheet: m ? m[1] : null };
  }
  /* page.open: the voice first says its one sentence, then the page opens. The
     destination's dock shows "Joya opened ..." with Undo (back here). Only when
     the shell (joya-shell.js) is missing: with it the page opens in its frame.
     It never ends a live call and never moves the tab while one is on, or while
     the shell is here (it refused that url): a link is shown instead. Returns
     false when it did not navigate. */
  var pageOpening = null;
  function pageOpenSoon(key, np) {
    if (liveActive() || window.JoyaShell) { uiToast(np.label + " — open it when you are ready", null, np.url); return false; }
    if (pageOpening) return true;
    pageOpening = { key: key, at: Date.now() };
    try { window.sessionStorage.setItem("joya-opened", JSON.stringify({ key: key, label: np.label, from: location.pathname, at: Date.now() })); } catch (e) { /* no undo there */ }
    var talking = function () { return !!((liveActive() && window.VoiceLive && window.VoiceLive.speaking()) || (typeof Voice !== "undefined" && Voice.speaking)); };
    var started = false, t0 = Date.now();
    (function wait() {
      var dt = Date.now() - t0;
      if (talking()) started = true;
      var done = started ? !talking() : dt > 2500;
      if (!done && dt < 9000) return setTimeout(wait, 150);
      if (liveActive()) { pageOpening = null; return uiToast(np.label + " — open it when you are ready", null, np.url); } // a call began meanwhile
      window.location.assign(np.url);
    })();
    return true;
  }
  function uiToast(text, undo, link) {
    if (shellUp()) {
      window.JoyaShell.toast(text, undo ? function () { uiUndoNow("click"); } : null, link);
      uiUndoState = undo ? { fn: undo, el: null, until: Date.now() + UI_UNDO_MS } : null;
      uiUndoSignal(undo ? UI_UNDO_MS : 0);
      return;
    }
    var old = document.querySelector(".cc-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "cc-toast cc-ui-toast";
    el.setAttribute("role", "status");
    var t = document.createElement("span");
    t.textContent = text;
    el.appendChild(t);
    if (link) {
      var l = document.createElement("a");
      l.className = "cc-btn sm";
      l.href = link;
      l.textContent = "Open";
      el.appendChild(l);
    }
    if (undo) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "cc-btn sm";
      b.setAttribute("data-ui-undo", "");
      b.textContent = "Undo";
      b.addEventListener("click", function () { uiUndoNow("click"); el.remove(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    uiUndoState = undo ? { fn: undo, el: el, until: Date.now() + UI_UNDO_MS } : null;
    uiUndoSignal(undo ? UI_UNDO_MS : 0);
    clearTimeout(uiToast.t);
    uiToast.t = setTimeout(function () { el.remove(); }, undo ? UI_UNDO_MS : link ? 8000 : 3500);
  }
  /* Tier 2 (UI control Phase 3): theme, voice persona and voice. The page only
     ASKS ("Switch the voice to cedar? Confirm / Cancel"); the change is made
     after a click on Confirm, or after the server heard the administrator's
     own "yes" (never the model's words) -- and then through the existing
     CSRF'd routes, under this session's own permissions. One at a time, 30 s. */
  var uiConfirmState = null;
  function uiConfirmAsk(ev, v) {
    if (!ev.confirm || !/^[0-9a-f]{18}$/.test(ev.confirm)) return { ok: false, why: "a preference needs the server's confirm" };
    var question = "Joya asks: " + (ev.toast || window.UiActions.toast(v.action, v.args));
    if (shellUp() && window.JoyaShell.confirm) {
      // A page is up in the shell: the dock asks, and the administrator stays on the page.
      var h = window.JoyaShell.confirm(question, function () { uiConfirmDecide(ev.confirm, "confirm"); }, function () { uiConfirmDecide(ev.confirm, "cancel"); });
      uiConfirmState = { id: ev.confirm, action: v.action, args: v.args, el: h };
      return { ok: true, pending: true };
    }
    var old = document.querySelector(".cc-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "cc-toast cc-ui-toast cc-ui-confirm";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-label", "Confirm a change Joya asked for");
    var t = document.createElement("span");
    t.textContent = question;
    el.appendChild(t);
    var yes = document.createElement("button");
    yes.type = "button"; yes.className = "cc-btn sm pri"; yes.setAttribute("data-ui-confirm", "yes"); yes.textContent = "Confirm";
    var no = document.createElement("button");
    no.type = "button"; no.className = "cc-btn sm"; no.setAttribute("data-ui-confirm", "no"); no.textContent = "Cancel";
    el.appendChild(yes); el.appendChild(no);
    var hint = document.createElement("small");
    hint.className = "cc-ui-confirm-hint";
    hint.textContent = "or say “yes” / «أيوه»";
    el.appendChild(hint);
    document.body.appendChild(el);
    uiConfirmState = { id: ev.confirm, action: v.action, args: v.args, el: el };
    yes.addEventListener("click", function () { uiConfirmDecide(ev.confirm, "confirm"); });
    no.addEventListener("click", function () { uiConfirmDecide(ev.confirm, "cancel"); });
    clearTimeout(uiToast.t);
    // The server says when it runs out (its 30 s start when the voice has finished asking); this is only a backstop.
    uiToast.t = setTimeout(function () { if (uiConfirmState && uiConfirmState.id === ev.confirm) uiConfirmExpired(ev.confirm, null); }, 90000);
    return { ok: true, pending: true };
  }
  /** The server: this confirm ran out unanswered. Nothing changed; the chip says so, then goes. */
  function uiConfirmExpired(id, line) {
    var st = uiConfirmState;
    if (!st || st.id !== id) return;
    uiConfirmState = null;
    if (st.el && st.el.expired) st.el.expired("Expired: nothing was changed.");
    else if (st.el) {
      [].forEach.call(st.el.querySelectorAll("button, small"), function (b) { b.remove(); });
      var sp = st.el.querySelector("span");
      if (sp) sp.textContent = "Expired: nothing was changed.";
      st.el.classList.add("expired");
      setTimeout(function () { st.el.remove(); }, 4000);
    }
  }
  /** The server heard a "yes" / "no" for this confirm. */
  function uiConfirmAnswer(id, ok) {
    if (!uiConfirmState || uiConfirmState.id !== id) return;
    if (ok) return uiConfirmDecide(id, "confirm");
    // A heard "no": the server has already cancelled it.
    uiConfirmState.el.remove();
    uiConfirmState = null;
    toast("Cancelled: nothing was changed.");
  }
  function uiConfirmDecide(id, decision) {
    var st = uiConfirmState;
    if (!st || st.id !== id) return;
    uiConfirmState = null;
    st.el.remove();
    api("ui/confirm", { body: { id: id, decision: decision } }).then(function (r) {
      if (!r || r.cancelled) return toast("Cancelled: nothing was changed.");
      return uiApply(r).then(function () { toast(r.done || "Done."); });
    }).catch(function (e) { toast("Not changed: " + ((e && e.message) || e), true); });
  }
  /** Apply a confirmed preference through the route its Settings control uses. */
  function uiApply(r) {
    if (r.action === "theme.set") {
      var b = document.querySelector('.topbar [data-theme-opt="' + r.args.theme + '"]');
      if (!b) return Promise.reject(new Error("the theme switch is not on this page"));
      b.click();
      return Promise.resolve();
    }
    var url = r.action === "persona.set" ? "/joya-ai/settings/voice/persona" : r.action === "voice.set" ? "/joya-ai/settings/voice/options" : null;
    if (!url || !r.form) return Promise.reject(new Error("not a preference this page can change"));
    var body = new URLSearchParams();
    body.set("_csrf", CSRF);
    Object.keys(r.form).forEach(function (k) { body.set(k, r.form[k]); });
    // The same form route as Settings, asked for JSON instead of its redirect.
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString() }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: "the setting was refused (" + res.status + ")" }; });
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "the setting was refused");
    });
  }
  window.__joyaUi = { run: runUiAction, undoable: uiUndoable, undo: uiUndoNow, confirming: function () { return uiConfirmState ? uiConfirmState.id : null; } };

  /* ============================================================ end of the live integration block */

  /* ================================================================ panels
     Missions, Decisions, Rules and Watchers, standing orders, cost, the deep
     view and the palette live in cc-panels.js; this is what they are given. */

  var CC = {
    S: S, root: root, api: api, esc: esc, ic: ic, md: md, num: num, clip: clip, firstLine: firstLine, plain: plain,
    hm: hm, hms: hms, when: when, ago: ago, dur: dur, modelLabel: modelLabel, applyBars: applyBars, toast: toast,
    fmtDay: fmtDay, fmtHM: fmtHM, fmtDate: fmtDate, TZ: TZ,
    AI_NAME: AI_NAME, isAiName: isAiName, aiLabel: aiLabel,
    liveSessions: liveSessions, selfSession: selfSession, sessKey: sessKey, sessState: sessState, sessIcon: sessIcon, sessWhere: sessWhere,
    selfState: selfState, findSess: findSess, sessionNamed: sessionNamed, sortSessions: sortSessions, subagentLabel: subagentLabel,
    setTarget: setTarget, showPane: showPane, openSheet: openSheet, closeSheet: closeSheet, send: send, focusInput: function () { input.focus(); },
    setCore: setCoreChoice, coreNow: coreNow, renderNeed: renderNeed, openNeed: openNeed, voice: function () { return Voice; },
    pendingApprovals: pendingApprovals, approvalHTML: approvalHTML, approvalCmd: approvalCmd, upsertApproval: upsertApproval,
    upsertTurn: upsertTurn, feedPush: feedPush, renderRail: renderRail, renderSessions: renderSessions, renderTurn: renderTurn, paintState: paintState,
    openRemoteControl: openRemoteControl, interrupt: interrupt, map: Orb, TL_LAB: TL_LAB,
    resyncSessions: function () { setSessions(S.sessions.filter(function (s) { return !s.synthetic; })); renderSessions(true); },
  };
  var P = window.JoyaPanels(CC);
  // The session story and the day timeline (cc-story.js): opening a session shows its story.
  if (window.JoyaStory) window.JoyaStory.attach(CC, P);

  /* ================================================================ keys */

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (menu) { closeMenu(); return; }
    if (e.defaultPrevented) return;   // the palette or a dialog took it
    if (!$("cc-pop").hidden) { closePop(); return; }
    if (!$("cc-reply").hidden) { closeReply(); return; }
    if (S.pane) { closeSheet(); return; }
    if (Need.open) closeNeed();
  });

  /* The caption follows the voice bar's line (Listening…, what was heard,
     Transcribing…) and the sentence being spoken. */
  Voice.onSpeak = function (text) { S.spoken = text; paintState(); };
  if (window.MutationObserver) new MutationObserver(function () { paintCaption(); }).observe($("cc-vb-text"), { childList: true, characterData: true, subtree: true });

  /* ================================================================ start */

  tick();
  setInterval(tick, 1000);
  Orb.start();
  paintCoreSwitches();
  renderAll();
  load();
  // Web fonts change the caption's height, and with it where the core sits.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { Orb.resize(); });
  window.addEventListener("load", function () { Orb.resize(); });
})();
