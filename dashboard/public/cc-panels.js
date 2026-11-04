"use strict";
/*
 * The Command Center's panels: the missions board, the Decisions inbox
 * (approvals and watcher findings), Rules and Watchers, the standing orders
 * (rail list and editor), usage (Claude plan limits, token counts, voice spend), the read-only
 * session deep view, the "Always allow this" rule dialog, the new-mission
 * dialog and the Ctrl+K command palette.
 *
 * Exposes one factory, window.JoyaPanels(CC), called by joya-ai.js with its
 * helpers and state; everything here goes through CC.api (same origin, CSRF on
 * writes) and every server string through CC.esc or CC.md. Nothing here writes
 * a style attribute: sizes that depend on data are data-w / data-v / data-l
 * attributes that CC.applyBars turns into element.style after the markup is in.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
 */
(function () {
  /* ---------------------------------------------------------- pure helpers */

  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /** A schedule in words, as the editor shows it before the server confirms. */
  function scheduleLabel(s) {
    s = s || {};
    var at = /^\d{1,2}:\d{2}$/.test(String(s.at || "")) ? String(s.at).padStart(5, "0") : "--:--";
    if (s.kind === "daily") return "Every day at " + at;
    if (s.kind === "weekdays") return "Weekdays at " + at;
    if (s.kind === "weekly") return "Every " + (DOW[Number(s.dow)] || "week") + " at " + at;
    if (s.kind === "hours") {
      var n = Math.max(1, Math.min(24, parseInt(s.every_h, 10) || 1));
      return n === 1 ? "Every hour" : "Every " + n + " hours";
    }
    if (s.kind === "cron") return "Cron: " + (String(s.cron || "").trim() || "(empty)");
    return "No schedule";
  }

  /** The rule pattern syntax: glob over the whole command, `*` any text, `\*` a literal star. */
  function globMatch(pattern, text) {
    var src = "", p = String(pattern || "");
    for (var i = 0; i < p.length; i++) {
      var c = p.charAt(i);
      if (c === "\\" && p.charAt(i + 1) === "*") { src += "\\*"; i++; }
      else if (c === "*") src += "[\\s\\S]*";
      else src += c.replace(/[.+?^${}()|[\]\\\/-]/g, "\\$&");
    }
    try { return new RegExp("^" + src + "$").test(String(text || "")); } catch (e) { return false; }
  }

  /** Fuzzy match for the palette: a substring wins, else letters in order. */
  function fuzzy(q, s) {
    q = String(q || "").toLowerCase();
    var tx = String(s || "").toLowerCase(), qi = 0, score = 0, prev = -2, idx = [];
    if (!q) return { score: 0, idx: [] };
    var at = tx.indexOf(q);
    if (at >= 0) {
      for (var j = 0; j < q.length; j++) idx.push(at + j);
      return { score: 100 + (at === 0 || tx.charAt(at - 1) === " " ? 20 : 0) - at * 0.2, idx: idx };
    }
    for (var i = 0; i < tx.length && qi < q.length; i++) {
      if (q.charAt(qi) === " ") { qi++; i--; continue; }
      if (tx.charAt(i) === q.charAt(qi)) {
        idx.push(i);
        score += (i === prev + 1 ? 3 : 0.5) + (i === 0 || tx.charAt(i - 1) === " " ? 3 : 0) - (prev >= 0 && i - prev > 6 ? 1.5 : 0);
        prev = i; qi++;
      }
    }
    return qi === q.length ? { score: score - tx.length * 0.01, idx: idx } : null;
  }

  /** Tokens as people read them: 812, 44k, 3.1M. */
  function tokens(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }

  /*
   * Claude plan usage, shown as Claude Code's /usage dialog shows it (read off
   * the 2.1.283 binary): "<floor(utilization)>% used", and "Resets <when>
   * (<time zone>)" where <when> is the time alone for a reset within 24 hours
   * and "Oct 5, 3pm" otherwise -- always the date on the weekly rows -- minutes
   * left out on the hour, am/pm in lower case, the year only when it differs.
   */
  var PlanUsage = {
    pctUsed: function (u) { var n = Number(u); return isFinite(n) ? Math.floor(n) : 0; },
    resetText: function (iso, alwaysDate, nowMs, tz) {
      var ms = Date.parse(iso);
      if (!isFinite(ms)) return "";
      var o = new Date(Math.floor(ms / 1000) * 1000), s = new Date(nowMs == null ? Date.now() : nowMs);
      var zone = tz || (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ""; } })();
      var opt = { hour: "numeric", hour12: true };
      if (zone && tz) opt.timeZone = tz;
      var mins = Number(new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: opt.timeZone }).format(o));
      if (mins !== 0) opt.minute = "2-digit";
      var txt, hoursAway = (o.getTime() - s.getTime()) / 3600000;
      if (alwaysDate || hoursAway > 24) {
        opt.month = "short";
        opt.day = "numeric";
        var yr = function (d) { return new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: opt.timeZone }).format(d); };
        if (yr(o) !== yr(s)) opt.year = "numeric";
        txt = o.toLocaleString("en-US", opt);
      } else txt = o.toLocaleTimeString("en-US", opt);
      txt = txt.replace(/[ \u202f]([AP]M)/i, function (m0, ap) { return ap.toLowerCase(); });
      return txt + (zone ? " (" + zone + ")" : "");
    },
    /** "in 2 h 26 min", "in 3 d 4 h": how long until a reset. */
    inText: function (iso, nowMs) {
      var ms = Date.parse(iso) - (nowMs == null ? Date.now() : nowMs);
      if (!isFinite(ms)) return "";
      if (ms <= 0) return "due now";
      var m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
      if (d) return "in " + d + " d" + (h ? " " + h + " h" : "");
      if (h) return "in " + h + " h" + (mm ? " " + mm + " min" : "");
      return "in " + Math.max(1, mm) + " min";
    },
    planName: function (t) {
      var k = String(t || "").toLowerCase();
      return { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" }[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
    },
    /** 1234567 -> "1,234,567" (a full count, for the details table). */
    fullNum: function (n) {
      n = Math.round(Number(n) || 0);
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    },
  };
  window.JoyaPlanUsage = PlanUsage;

  window.JoyaPanels = function (CC) {
    var ML = window.JoyaLogic, S = CC.S, esc = CC.esc, ic = CC.ic, api = CC.api, toast = CC.toast, clip = CC.clip, hm = CC.hm, dur = CC.dur;
    function $(id) { return document.getElementById(id); }

    var P = {
      missions: new Map(), decisions: new Map(), watchers: [], rules: [], orders: [], ordersTz: "Africa/Cairo", telegram: null,
      cost: null, err: {}, activeMis: null, rulesSub: "rules", editRule: null, addRule: false, newRule: null, confirmDel: null,
      tryText: "", tryTool: "Bash", tryRes: null, ask: {}, decPending: false, rulesPending: false,
    };

    /* ======================================================== overlays */

    var OV = { kind: null, prev: null, timer: 0, deep: null, ed: null, pal: null };
    function overlay(kind, html, cls, label) {
      closeOverlay(true);
      OV.kind = kind;
      OV.prev = document.activeElement;
      $("cc-overlay").innerHTML = '<div class="cc-scrim" data-close></div><div class="' + cls + '" role="dialog" aria-modal="true" aria-label="' + esc(label || kind) + '" id="cc-ov">' + html + "</div>";
      var f = $("cc-ov").querySelector("[data-autofocus]") || $("cc-ov").querySelector("input, textarea, button:not([data-close])");
      // Nothing to focus yet (a conversation still loading): the dialog itself, so Esc, Tab and the wheel reach it.
      if (!f) { $("cc-ov").setAttribute("tabindex", "-1"); f = $("cc-ov"); }
      f.focus();
      return $("cc-ov");
    }
    function closeOverlay(quiet) {
      clearInterval(OV.timer);
      OV.timer = 0;
      OV.deep = null;
      OV.ed = null;
      OV.pal = null;
      var had = OV.kind;
      OV.kind = null;
      $("cc-overlay").innerHTML = "";
      if (had && !quiet && OV.prev && OV.prev.focus && document.contains(OV.prev)) OV.prev.focus();
    }
    $("cc-overlay").addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) closeOverlay();
    });
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        if (OV.kind === "palette") closeOverlay(); else openPalette();
        return;
      }
      if (e.key === "Escape" && OV.kind) { e.preventDefault(); closeOverlay(); }
    });
    $("cc-kbtn").addEventListener("click", function () { openPalette(); });
    document.addEventListener("click", function (e) {
      var o = e.target.closest("[data-open]");
      if (!o) return;
      var k = o.getAttribute("data-open");
      if (k === "cost") openCost();
      else if (k === "order-new") openOrder(null);
      else if (k === "mission-new") openNewMission();
    });

    function btnBusy(b, on) { if (b) b.disabled = !!on; }
    function errText(e) { return e && e.message ? e.message : String(e || "failed"); }

    /* ======================================================== centre views */

    /* The v3 centre switched Map | Missions; now the core is always in the
       centre and the missions board is a sheet. */
    function setView(v) {
      if (v === "missions") CC.openSheet("missions");
      else CC.closeSheet();
    }

    /* ======================================================== missions */

    var LANES = [["planned", "Planned", "idle"], ["delegated", "Delegated", "idle"], ["working", "Working", "work"], ["waiting_approval", "Waiting approval", "bad"], ["done", "Done", ""]];
    function laneOf(st) { return st === "failed" || st === "skipped" ? "done" : st; }
    function missionList() {
      var list = [];
      P.missions.forEach(function (m) { list.push(m); });
      var rank = { active: 0, planned: 1, done: 2, failed: 3, cancelled: 4 };
      return list.sort(function (a, b) {
        return (rank[a.status] - rank[b.status]) || String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""));
      });
    }
    function activeMissions() { return missionList().filter(function (m) { return m.status === "active"; }); }
    function currentMission() {
      var m = P.activeMis && P.missions.get(P.activeMis);
      if (m) return m;
      var l = missionList();
      return l[0] || null;
    }
    function progress(m) {
      var mt = m.metrics || {}, steps = m.steps || [];
      var done = mt.steps_done != null ? mt.steps_done : steps.filter(function (s) { return s.status === "done"; }).length;
      var total = mt.steps_total != null ? mt.steps_total : steps.length;
      return [done, total];
    }
    function upsertMission(m, replay) {
      if (!m || m.id == null) return;
      var had = P.missions.get(m.id);
      P.missions.set(m.id, m);
      if (!replay && !had) {
        CC.feedPush({ key: "mis" + m.id, ts: m.created_at, kind: "mission", label: "mission", html: "Mission <b>" + esc(m.ref || "") + "</b> · " + esc(clip(m.title || m.goal, 120)) });
        if (!P.activeMis || !P.missions.get(P.activeMis) || P.missions.get(P.activeMis).status !== "active") P.activeMis = m.id;
        toast("Mission " + (m.ref || "") + " planned: " + clip(m.title || m.goal, 60));
      }
      if (!replay && had && had.status !== m.status && (m.status === "done" || m.status === "failed")) {
        CC.feedPush({ key: "mis" + m.id + m.status, ts: m.done_at || m.updated_at, kind: m.status === "done" ? "done" : "failed", label: "mission", html: "Mission <b>" + esc(m.ref || "") + "</b> " + esc(m.status) });
      }
      renderMisChip();
      if (S.pane === "missions") renderMissions();
      CC.resyncSessions();
    }
    function renderMisChip() {
      var act = activeMissions();
      var n = S.status && S.status.counts && S.status.counts.missions_active != null ? S.status.counts.missions_active : act.length;
      $("cc-mis-count").textContent = n;
      $("cc-mis-count").hidden = !n;
      var m = P.activeMis && P.missions.get(P.activeMis);
      if (!m || m.status !== "active") m = act[0];
      var chip = $("cc-mis-chip");
      // The rail's Missions button only while a mission is open (planned) or running, or its sheet is open
      // (2026-10-25 cleanup); New mission stays in Search (Ctrl K) and in the Everything sheet.
      var railBtn = document.querySelector('#cc-rail [data-sheet="missions"]');
      if (railBtn) railBtn.hidden = !(S.pane === "missions" || missionList().some(function (x) { return x.status === "active" || x.status === "planned"; }));
      if (!m) { chip.hidden = true; return; }
      var p = progress(m);
      chip.hidden = false;
      chip.setAttribute("data-mis", m.id);
      chip.innerHTML = ic("flag") + "<b>" + esc(m.ref || "Mission") + '</b><span class="tt">' + esc(m.title || m.goal || "") + '</span><span class="pbar"><i data-w="' + (p[1] ? p[0] / p[1] * 100 : 0) + '"></i></span><small>' + p[0] + "/" + p[1] + "</small>";
      CC.applyBars(chip);
    }
    $("cc-mis-chip").addEventListener("click", function () {
      var id = $("cc-mis-chip").getAttribute("data-mis");
      if (id != null) P.activeMis = P.missions.has(id) ? id : Number(id);
      setView("missions");
      renderMissions();
    });

    function whoChip(target) {
      if (!target) return "";
      if (target === "joya-ai") return '<span class="sess me">' + ic("core") + "<span>JOYA AI</span></span>";
      var live = CC.sessionNamed(target);
      return '<span class="sess"' + (live ? "" : ' title="not running now"') + ">" + (live ? ic(CC.sessIcon(live)) : "") + "<span>" + esc(target) + "</span></span>";
    }
    function stepTime(s) {
      if (s.status === "planned") return "";
      var a = Date.parse(s.started_at || s.updated_at || s.created_at), b = s.done_at ? Date.parse(s.done_at) : Date.now();
      if (!isFinite(a)) return "";
      return dur(Math.max(0, b - a));
    }
    function renderMissions() {
      var list = missionList();
      var m = currentMission();
      if (m) P.activeMis = m.id;
      var shown = list.filter(function (x) { return x.status === "active" || x.status === "planned"; });
      list.forEach(function (x) { if (shown.length < 6 && shown.indexOf(x) < 0) shown.push(x); });
      if (m && shown.indexOf(m) < 0) shown.unshift(m);
      $("cc-mis-tabs").innerHTML = shown.slice(0, 7).map(function (x) {
        var dot = x.status === "active" ? "work" : x.status === "done" ? "" : x.status === "failed" ? "bad" : "idle";
        return '<button type="button" class="cc-mis-tab' + (m && x.id === m.id ? " on" : "") + '" data-mis="' + esc(x.id) + '" title="' + esc(x.title || x.goal || "") + '"><span class="cc-dot ' + dot + '"></span><b>' + esc(x.ref || "M") + "</b>" + esc(x.status) + "</button>";
      }).join("") + '<button type="button" class="cc-mis-tab new" data-open="mission-new">' + ic("plus") + "New mission</button>";
      if (!m) {
        $("cc-mis-head").innerHTML = "";
        $("cc-mis-head").hidden = true;
        $("cc-lanes").innerHTML = '<div class="cc-mis-empty"><b>No missions yet</b><span>' + esc(P.err.missions ? "Missions are not available: " + P.err.missions : "A mission is a goal JOYA AI plans into steps and hands to the sessions that own the work. You see each step move across this board.") +
          '</span><button type="button" class="cc-btn pri" data-open="mission-new">' + ic("plus") + "New mission</button></div>";
        return;
      }
      $("cc-mis-head").hidden = false;
      var p = progress(m), mt = m.metrics || {};
      var sess = mt.sessions ? mt.sessions.length : 0;
      var elapsed = mt.elapsed_s != null ? dur(mt.elapsed_s * 1000) : "—";
      $("cc-mis-head").innerHTML = '<div class="cc-min0"><h3>' + esc(m.ref || "") + " · " + esc(m.title || "") + "</h3><p>" + esc(m.goal || "") + '</p></div>' +
        '<div class="cc-mis-kpis"><div><b>' + p[0] + "/" + p[1] + "</b><span>steps done</span></div><div><b>" + sess + "</b><span>sessions</span></div><div><b>" + esc(elapsed) + "</b><span>elapsed</span></div><div" + (mt.tokens ? ' title="' + esc(ML.tokTip(mt.tokens, "JOYA AI\u2019s turns on this mission")) + '"' : "") + "><b>" + esc(mt.tokens ? ML.tokens(mt.tokens.total) : "—") + "</b><span>tokens</span></div></div>" +
        '<div class="cc-mis-prog"><i data-w="' + (p[1] ? p[0] / p[1] * 100 : 0) + '"></i></div>';
      CC.applyBars($("cc-mis-head"));
      var steps = (m.steps || []).slice().sort(function (a, b) { return a.n - b.n; });
      $("cc-lanes").innerHTML = LANES.map(function (l) {
        var items = steps.filter(function (s) { return laneOf(s.status) === l[0]; });
        return '<div class="cc-lane"><div class="cc-lane-h"><span class="cc-dot ' + l[2] + '"></span><span class="lt" title="' + l[1] + '">' + l[1] + '</span><span class="cc-count' + (l[0] === "waiting_approval" && items.length ? " warn" : "") + '">' + items.length + '</span></div><div class="cc-lane-b cc-scroll">' +
          (items.length ? items.map(function (s) {
            var res = s.status === "waiting_approval" ? '<div class="res bad">' + esc(s.note || "Waiting for your approval in Decisions") + "</div>"
              : s.result ? '<div class="res' + (s.status === "failed" ? " bad" : "") + '">' + esc(clip(s.result, 300)) + "</div>"
              : s.note ? '<div class="res' + (s.status === "failed" ? " bad" : "") + '">' + esc(clip(s.note, 200)) + "</div>" : "";
            return '<div class="cc-step ' + esc(s.status) + '" data-step="' + esc(s.id) + '" role="button" tabindex="0" title="' + esc(s.detail || s.title || "") + '"><span class="n">STEP ' + esc(s.n) + (s.status === "failed" || s.status === "skipped" ? " · " + esc(s.status) : "") + "</span><p>" + esc(s.title || "") + '</p><div class="meta">' + whoChip(s.target) + '<span class="t">' + esc(stepTime(s)) + "</span></div>" + res + "</div>";
          }).join("") : '<div class="cc-lane-empty">nothing here</div>') + "</div></div>";
      }).join("");
    }
    $("cc-mis-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-mis]");
      if (!b) return;
      var id = b.getAttribute("data-mis");
      P.activeMis = P.missions.has(id) ? id : Number(id);
      renderMissions();
      renderMisChip();
    });
    function stepAction(el) {
      var m = currentMission();
      if (!m) return;
      var id = el.getAttribute("data-step"), s = null;
      (m.steps || []).forEach(function (x) { if (String(x.id) === id) s = x; });
      if (!s) return;
      if (s.status === "waiting_approval") { CC.showPane("dec"); return; }
      if (s.target && s.target !== "joya-ai") {
        var live = CC.sessionNamed(s.target);
        if (live) { openDeep(CC.sessKey(live)); return; }
      }
      if (s.target === "joya-ai") { var me = CC.selfSession(); if (me) openDeep(CC.sessKey(me)); }
    }
    $("cc-lanes").addEventListener("click", function (e) { var st = e.target.closest("[data-step]"); if (st) stepAction(st); });
    $("cc-lanes").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var st = e.target.closest("[data-step]");
      if (st) { e.preventDefault(); stepAction(st); }
    });

    function openNewMission(goal) {
      var ov = overlay("mission",
        '<div class="cc-mh">' + ic("flag") + '<div class="cc-min0"><h2>New mission</h2><small>JOYA AI plans the steps, delegates each to the session that owns the work, and reports back.</small></div><div class="cc-sp"><button type="button" class="cc-iconbtn" data-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></div>" +
        '<div class="cc-mb-body"><div class="cc-form"><label class="top" for="cc-mis-goal">Goal</label><textarea class="cc-in" id="cc-mis-goal" rows="4" maxlength="4000" data-autofocus placeholder="What should be true when it is done?">' + esc(goal || "") + "</textarea>" +
        '<span></span><span class="hint">Destructive steps still wait for your approval in Decisions. You can follow every step on the Missions board.</span></div></div>' +
        '<div class="cc-mf"><span class="cc-err" id="cc-mis-err"></span><div class="cc-sp"><button type="button" class="cc-btn" data-close>Cancel</button><button type="button" class="cc-btn pri" id="cc-mis-go">' + ic("send") + "Send to JOYA AI</button></div></div>",
        "cc-modal narrow", "New mission");
      function go() {
        var g = $("cc-mis-goal").value.trim();
        if (!g) { $("cc-mis-err").textContent = "Write the goal first."; return; }
        btnBusy($("cc-mis-go"), true);
        api("missions/request", { body: { goal: g } }).then(function (r) {
          if (r && r.turn) CC.upsertTurn(r.turn);
          closeOverlay();
          toast("Sent to JOYA AI. It plans the mission and it appears on the board.");
          CC.showPane("conv");
        }).catch(function (e) {
          btnBusy($("cc-mis-go"), false);
          $("cc-mis-err").textContent = "Not sent: " + errText(e);
        });
      }
      $("cc-mis-go").addEventListener("click", go);
      ov.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) go(); });
    }

    /* ======================================================== decisions */

    var NEED = { investigating: 1, proposed: 1, open: 1 };
    var PROGRESS = { approved: 1, running: 1 };
    function decisionsNeeding() {
      var out = [];
      P.decisions.forEach(function (d) { if (NEED[d.status]) out.push(d); });
      return out.sort(function (a, b) { return String(b.last_seen || b.updated_at || "").localeCompare(String(a.last_seen || a.updated_at || "")); });
    }
    function decCount() { return CC.pendingApprovals().length + decisionsNeeding().length; }
    function upsertDecision(d, replay) {
      if (!d || d.id == null) return;
      var had = P.decisions.get(d.id);
      P.decisions.set(d.id, d);
      if (!replay && (!had || had.status !== d.status)) {
        if (d.status === "proposed" || (!had && NEED[d.status])) {
          CC.feedPush({ key: "dec" + d.id + d.status, ts: d.updated_at || d.last_seen, kind: "watcher", label: d.kind === "watcher" ? "watcher" : d.kind, html: "<b>" + esc(d.title || "Decision") + "</b>" + (d.status === "proposed" ? " · a fix is proposed" : " · " + esc(d.status)) });
          d._fresh = true;
          if (!had) toast((d.kind === "watcher" ? "Watcher: " : "") + clip(d.title || "a new decision", 80));
        }
      }
      renderDecisions();
    }
    function decTime(d) { return hm(d.last_seen || d.updated_at || d.created_at); }
    function watcherName(key) {
      for (var i = 0; i < P.watchers.length; i++) if (P.watchers[i].key === key) return P.watchers[i].name;
      return key ? String(key).replace(/_/g, " ") : "";
    }
    function decCard(d) {
      var st = d.status, done = !NEED[st] && !PROGRESS[st];
      var head = (d.kind === "watcher" ? ic("eye") + "Watcher" + (d.watcher ? " · " + esc(watcherName(d.watcher)) : "") : d.kind === "cap" ? ic("gauge") + "Daily token cap" : ic("info") + esc(d.kind || "decision")) +
        (d.subject ? '<span class="cc-badge b-mute">' + esc(clip(d.subject, 40)) + "</span>" : "") +
        (d.count > 1 ? '<span class="cc-badge b-mute" title="Seen this many times">×' + esc(d.count) + "</span>" : "") +
        "<time>" + esc(decTime(d)) + "</time>";
      var b = "<p><b>" + esc(d.title || "") + "</b>" + (d.detail ? " " + esc(d.detail) : "") + "</p>";
      if (d.evidence) b += '<pre class="cc-ev">' + esc(d.evidence) + "</pre>";
      if (d.proposal || d.fix_command) b += '<div class="cc-fix"><b>Proposed fix</b>' + esc(d.proposal || "") + (d.fix_command ? "<code>$ " + esc(d.fix_command) + "</code>" : "") + "</div>";
      if (d.kind === "cap" && st === "open") {
        // A session at its daily token cap (Settings > Usage & budget): Resume for today, or leave it.
        var acts = d.actions || [];
        b += '<div class="cc-dact">' + (acts.indexOf("resume") >= 0 ? '<button type="button" class="cc-btn pri sm" data-dact="resume">' + ic("play") + "Resume for today</button>" : "") +
          '<button type="button" class="cc-btn sm" data-dact="dismiss">' + (acts.indexOf("resume") >= 0 ? "Leave paused" : "Dismiss") + "</button></div>";
      } else if (st === "proposed") {
        b += '<div class="cc-dact"><button type="button" class="cc-btn pri sm" data-dact="approve">' + ic("check") + 'Approve fix</button><button type="button" class="cc-btn sm" data-dact="dismiss">Dismiss</button><button type="button" class="cc-btn sm" data-dact="ask">' + ic("message") + "Ask more</button></div>";
        if (d.fix_command) b += '<div class="cc-rule-hint">Approving asks JOYA AI to run the fix through the gate; a destructive command still raises its own approval card.</div>';
      } else if (st === "investigating") {
        b += '<div class="cc-dact"><span class="cc-dres work"><span class="cc-spin"></span>JOYA AI is investigating…</span><button type="button" class="cc-btn sm" data-dact="dismiss">Dismiss</button></div>';
      } else if (st === "open") {
        if (d.rate_limited) b += '<div class="cc-rule-hint">Not investigated yet: JOYA AI is holding back so a noisy watcher cannot flood it. Investigate to ask it now.</div>';
        b += '<div class="cc-dact"><button type="button" class="cc-btn pri sm" data-dact="investigate">' + ic("search") + 'Investigate</button><button type="button" class="cc-btn sm" data-dact="dismiss">Dismiss</button><button type="button" class="cc-btn sm" data-dact="ask">' + ic("message") + "Ask more</button></div>";
      } else if (PROGRESS[st]) {
        b += '<div class="cc-dres work"><span class="cc-spin"></span>' + (st === "approved" ? "Fix approved" + (d.decided_by ? " by " + esc(CC.aiLabel(d.decided_by)) : "") + " — queued for JOYA AI" : "JOYA AI is running the fix") + "</div>";
      } else {
        var txt = st === "done" ? "Done" + (d.result ? " · " + d.result : "") : st === "dismissed" ? "Dismissed" + (d.decided_by ? " by " + CC.aiLabel(d.decided_by) : "") : st === "failed" ? "Failed" + (d.result ? " · " + d.result : "") : st;
        b += '<div class="cc-dres' + (st === "dismissed" ? " no" : st === "failed" ? " bad" : "") + '">' + ic(st === "done" ? "check" : "close") + "<span>" + esc(clip(txt, 300)) + (d.decided_at ? " · " + esc(hm(d.decided_at)) : "") + "</span></div>";
      }
      if (P.ask[d.id] != null && !done) {
        b += '<div class="cc-ask"><textarea class="cc-in" data-ask-text rows="2" maxlength="4000" placeholder="What do you want JOYA AI to find out?">' + esc(P.ask[d.id]) + '</textarea><div class="cc-dact"><button type="button" class="cc-btn sm" data-dact="ask-cancel">Cancel</button><button type="button" class="cc-btn pri sm" data-dact="ask-send">' + ic("send") + "Ask</button></div></div>";
      }
      b += '<div class="cc-ap-err" data-err hidden></div>';
      return '<div class="cc-dec-card ' + esc(d.kind || "") + (done ? " done" : "") + (d._fresh ? " fresh" : "") + '" data-dec="' + esc(d.id) + '"><div class="cc-dec-h">' + head + '</div><div class="cc-dec-b">' + b + "</div></div>";
    }
    function recentlyDecided(a) { return a.status !== "pending" && Date.now() - Date.parse(a.decided_at || a.created_at) < 24 * 3600 * 1000; }
    function renderDecisions() {
      var n = decCount();
      $("cc-dec-count").textContent = n;
      $("cc-dec-count").hidden = !n;
      $("cc-dec-sub").textContent = n ? n + " need you" : "nothing waiting · approvals and watcher findings";
      if (CC.renderNeed) CC.renderNeed();
      if (S.pane !== "dec") { P.decPending = true; return; }
      var list = $("cc-dec-list"), ae = document.activeElement;
      // Never re-draw under someone typing an "Ask more" question.
      if (ae && list.contains(ae) && ae.tagName === "TEXTAREA") { P.decPending = true; return; }
      P.decPending = false;
      var aps = CC.pendingApprovals().sort(function (a, b) { return a.id - b.id; });
      var need = decisionsNeeding();
      var prog = [], handled = [];
      P.decisions.forEach(function (d) {
        if (PROGRESS[d.status]) prog.push(d);
        else if (!NEED[d.status] && Date.now() - Date.parse(d.decided_at || d.updated_at || d.created_at) < 24 * 3600 * 1000) handled.push(d);
      });
      var apDone = [];
      S.approvals.forEach(function (a) { if (recentlyDecided(a)) apDone.push(a); });
      apDone.sort(function (a, b) { return String(b.decided_at || "").localeCompare(String(a.decided_at || "")); });
      handled.sort(function (a, b) { return String(b.decided_at || b.updated_at || "").localeCompare(String(a.decided_at || a.updated_at || "")); });
      var h = '<div class="cc-inbox-h"><span class="cc-dot ' + (n ? "bad" : "") + '"></span>Needs you<span class="cc-muted">' + n + " open</span></div>";
      if (!n) h += '<div class="cc-dec-empty">' + esc(P.err.decisions ? "Decisions are not available: " + P.err.decisions : "Nothing needs you. The watchers are listening.") + "</div>";
      h += aps.map(CC.approvalHTML).join("") + need.map(decCard).join("");
      if (prog.length) h += '<div class="cc-inbox-h gap">' + ic("bolt") + "In progress<span class=\"cc-muted\">" + prog.length + "</span></div>" + prog.map(decCard).join("");
      if (handled.length || apDone.length) {
        h += '<div class="cc-inbox-h gap">' + ic("check") + 'Handled today<span class="cc-muted">' + (handled.length + apDone.length) + "</span></div>";
        h += handled.slice(0, 10).map(decCard).join("") + apDone.slice(0, 8).map(CC.approvalHTML).join("");
      }
      list.innerHTML = h;
      P.decisions.forEach(function (d) { d._fresh = false; });
    }
    function decAct(card, act) {
      var id = card.getAttribute("data-dec");
      var d = P.decisions.get(id) || P.decisions.get(Number(id));
      if (!d) return;
      var err = card.querySelector("[data-err]");
      function fail(e) {
        var bs = card.querySelectorAll("[data-dact]");
        for (var i = 0; i < bs.length; i++) bs[i].disabled = false;
        if (err) { err.hidden = false; err.textContent = "Not recorded: " + errText(e); }
      }
      function lock() { var bs = card.querySelectorAll("[data-dact]"); for (var i = 0; i < bs.length; i++) bs[i].disabled = true; }
      if (act === "ask") { P.ask[d.id] = P.ask[d.id] || ""; renderDecisions(); var ta = $("cc-dec-list").querySelector('[data-dec="' + cssq(d.id) + '"] [data-ask-text]'); if (ta) ta.focus(); return; }
      if (act === "ask-cancel") { delete P.ask[d.id]; renderDecisions(); return; }
      if (act === "ask-send" || act === "investigate") {
        var text = act === "investigate" ? "Investigate this and propose a fix." : String((card.querySelector("[data-ask-text]") || {}).value || "").trim();
        if (!text) { if (err) { err.hidden = false; err.textContent = "Write the question first."; } return; }
        lock();
        api("decisions/" + encodeURIComponent(d.id) + "/ask", { body: { text: text } }).then(function (r) {
          delete P.ask[d.id];
          if (r && r.turn) CC.upsertTurn(r.turn);
          if (r && r.decision) upsertDecision(r.decision, true); else renderDecisions();
          toast(act === "investigate" ? "JOYA AI is looking into it." : "Asked JOYA AI. The answer lands in the conversation.");
        }).catch(fail);
        return;
      }
      if (act === "approve" || act === "dismiss" || act === "resume") {
        lock();
        api("decisions/" + encodeURIComponent(d.id) + "/" + act, { body: {} }).then(function (r) {
          if (r && r.decision) upsertDecision(r.decision, true);
          else if (act === "resume") { d.status = "done"; d.result = "Resumed for today"; renderDecisions(); }
          toast(act === "approve" ? "Fix approved. JOYA AI runs it through the gate." : act === "resume" ? "Resumed for the rest of today." : d.kind === "cap" ? "Left as it is." : "Dismissed.");
        }).catch(fail);
      }
    }
    function cssq(v) { return window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v); }
    $("cc-dec-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-dact]");
      if (!b || b.disabled) return;
      var card = b.closest("[data-dec]");
      if (card) decAct(card, b.getAttribute("data-dact"));
    });
    $("cc-dec-list").addEventListener("input", function (e) {
      if (!e.target.hasAttribute("data-ask-text")) return;
      var card = e.target.closest("[data-dec]");
      var id = card.getAttribute("data-dec"), d = P.decisions.get(id) || P.decisions.get(Number(id));
      if (d) P.ask[d.id] = e.target.value;
    });
    $("cc-dec-list").addEventListener("focusout", function () { setTimeout(function () { if (P.decPending) renderDecisions(); }, 0); });

    /* ------------------------------------------------ "Always allow this" */

    function openAlways(id) {
      var a = S.approvals.get(id);
      if (!a) return;
      var cmd = CC.approvalCmd(a);
      var ov = overlay("always",
        '<div class="cc-mh">' + ic("scale") + '<div class="cc-min0"><h2>Always allow this</h2><small>Adds an allow rule to JOYA AI\'s approval gate, then approves this request.</small></div><div class="cc-sp"><button type="button" class="cc-iconbtn" data-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></div>" +
        '<div class="cc-mb-body" id="cc-al-body"><div class="cc-empty-s">Asking JOYA AI\'s gate for the rule it would add…</div></div>' +
        '<div class="cc-mf"><span class="cc-err" id="cc-al-err"></span><div class="cc-sp"><button type="button" class="cc-btn" data-close>Cancel</button><button type="button" class="cc-btn pri" id="cc-al-save" disabled>' + ic("check") + "Save rule and approve</button></div></div>",
        "cc-modal narrow", "Always allow this");
      var tool = a.tool === "SendMessage" ? "SendMessage" : "Bash";
      var subject = a.tool === "SendMessage" ? String((a.input || {}).to || "").replace(/\s*\[[0-9a-f]+\]$/, "") + ": " + cmd.text : cmd.text;
      function show(rule) {
        if (!$("cc-al-body")) return;
        tool = rule.tool || tool;
        $("cc-al-body").innerHTML =
          '<div class="cc-sec-t">The request</div><div class="cc-ap-cmd' + (cmd.shell ? " shell" : "") + '">' + esc(clip(cmd.text, 1200)) + "</div>" +
          '<div class="cc-form">' +
          '<label for="cc-al-pat">Pattern</label><input class="cc-in cc-mono" id="cc-al-pat" maxlength="1000" data-autofocus value="' + esc(rule.pattern || "") + '">' +
          '<span></span><span class="hint">Glob over the whole ' + (tool === "SendMessage" ? "“session: message”" : "command") + ": <code>*</code> is any text, <code>\\*</code> a literal star.</span>" +
          '<label>Effect</label><div class="cc-chips-sel sm"><button type="button" class="on" disabled>always allow</button></div>' +
          '<label>Tool</label><div class="cc-chips-sel sm"><button type="button" class="on" disabled>' + esc(tool) + "</button></div>" +
          '<label>Scope</label><div class="cc-chips-sel sm"><button type="button" class="on" disabled>' + ic("core") + 'JOYA AI</button><button type="button" class="on" disabled>' + ic("server") + "this VPS</button></div>" +
          (rule.note ? '<label>Note</label><span class="cc-muted">' + esc(rule.note) + "</span>" : "") +
          '<span></span><span class="hint" id="cc-al-match"></span></div>' +
          '<p class="cc-rule-hint">Deny rules still win, and built-in asks cannot be overridden. You can edit or delete the rule later in Rules. Saving approves this request too, so ' + (document.body.getAttribute("data-signin") === "password" ? "your password" : "Windows Hello (or your authenticator code)") + ' is asked first.</p>';
        var pat = $("cc-al-pat");
        function check() {
          var ok = globMatch(pat.value, subject);
          $("cc-al-match").textContent = !pat.value.trim() ? "Write a pattern." : ok ? "Matches this request." : "Does not match this request as written — it would not approve similar ones.";
          $("cc-al-save").disabled = !pat.value.trim();
        }
        pat.addEventListener("input", check);
        check();
        pat.focus();
      }
      api("approvals/" + id + "/rule-suggestion").then(function (r) { show((r && r.rule) || a.rule_suggestion || { pattern: cmd.text }); }).catch(function (e) {
        if ($("cc-al-err")) $("cc-al-err").textContent = "The gate did not suggest a rule (" + errText(e) + "); edit this one.";
        show(a.rule_suggestion || { pattern: cmd.text, tool: tool });
      });
      $("cc-al-save").addEventListener("click", function () {
        var pattern = $("cc-al-pat") ? $("cc-al-pat").value.trim() : "";
        if (!pattern) return;
        btnBusy($("cc-al-save"), true);
        api("approvals/" + id + "/approve", { body: { rule: { pattern: pattern, tool: tool } } }).then(function (r) {
          if (r && r.rule) upsertRule(r.rule, true), P.newRule = r.rule.id;
          if (r && r.approval) CC.upsertApproval(r.approval, false);
          closeOverlay();
          toast("Approved, and the rule is saved: " + clip(pattern, 60));
        }).catch(function (e) {
          btnBusy($("cc-al-save"), false);
          $("cc-al-err").textContent = "Not saved: " + errText(e);
        });
      });
      return ov;
    }

    /* ======================================================== rules + watchers */

    var EFF = { allow: "always allow", ask: "always ask", deny: "never allow" };
    function effBadge(e) { return '<span class="cc-badge b-' + esc(e) + '">' + esc(EFF[e] || e) + "</span>"; }
    function upsertRule(r, quiet) {
      if (!r) return;
      var i = P.rules.findIndex(function (x) { return x.id === r.id; });
      if (i >= 0) P.rules[i] = r; else P.rules.push(r);
      P.rules.sort(function (a, b) { return (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0); });
      if (!quiet) renderRules(); else renderRules();
    }
    function ruleForm(r) {
      r = r || { effect: "allow", tool: "Bash", pattern: "", note: "" };
      function chips(name, vals, cur) {
        return '<div class="cc-chips-sel sm" data-rf="' + name + '">' + vals.map(function (v) {
          return '<button type="button" data-v="' + esc(v[0]) + '" aria-pressed="' + (cur === v[0]) + '">' + esc(v[1]) + "</button>";
        }).join("") + "</div>";
      }
      return '<div class="cc-rule-form" data-rule-form="' + esc(r.id || "") + '">' +
        '<div class="row"><label>Effect</label>' + chips("effect", [["allow", "always allow"], ["ask", "always ask"], ["deny", "never allow"]], r.effect) + "</div>" +
        '<div class="row"><label>Tool</label>' + chips("tool", [["Bash", "Bash"], ["SendMessage", "SendMessage"], ["any", "any"]], r.tool) + "</div>" +
        '<input class="cc-in cc-mono" data-rf-pat maxlength="1000" placeholder="systemctl restart odoo*" value="' + esc(r.pattern || "") + '">' +
        '<input class="cc-in" data-rf-note maxlength="300" placeholder="Why (optional)" value="' + esc(r.note || "") + '">' +
        '<div class="cc-dact"><span class="cc-ap-err" data-rf-err></span><span class="cc-sp"></span><button type="button" class="cc-btn sm" data-ract="cancel">Cancel</button><button type="button" class="cc-btn pri sm" data-ract="save">' + ic("check") + "Save rule</button></div></div>";
    }
    function ruleRow(r) {
      if (P.editRule === r.id) return '<li class="cc-rule edit">' + ruleForm(r) + "</li>";
      var scope = '<span class="cc-badge b-mute">' + esc(r.scope_session === "joya-ai" || !r.scope_session ? "JOYA AI" : r.scope_session) + '</span><span class="cc-badge b-mute">' + esc(r.scope_machine === "this" || !r.scope_machine ? "this VPS" : r.scope_machine) + "</span>";
      var meta = [];
      if (r.builtin) meta.push(r.hard ? "built in · cannot be overridden" : "built in");
      else if (r.created_by) meta.push("by " + CC.aiLabel(r.created_by) + (r.source_approval_id ? " (from an approval card)" : ""));
      if (r.created_at && !r.builtin) meta.push(CC.fmtDay.format(new Date(r.created_at)));
      if (r.uses) meta.push("used " + r.uses + "×" + (r.last_used_at ? ", last " + hm(r.last_used_at) : ""));
      var btns = r.builtin || r.locked || r.hard ? '<span class="cc-lock" title="Built in: cannot be edited or deleted">' + ic("lock") + "</span>"
        : '<span class="cc-rule-btns">' + (P.confirmDel === r.id
          ? '<button type="button" class="cc-btn danger sm" data-ract="delete-yes" data-rid="' + esc(r.id) + '">Delete</button><button type="button" class="cc-btn sm" data-ract="delete-no">Keep</button>'
          : '<button type="button" class="cc-iconbtn" data-ract="edit" data-rid="' + esc(r.id) + '" title="Edit rule" aria-label="Edit rule">' + ic("edit") + '</button><button type="button" class="cc-iconbtn" data-ract="delete" data-rid="' + esc(r.id) + '" title="Delete rule" aria-label="Delete rule">' + ic("trash") + "</button>") + "</span>";
      return '<li class="cc-rule' + (P.newRule === r.id ? " new" : "") + '" data-rule="' + esc(r.id) + '"><div class="cc-rule-top">' + effBadge(r.effect) + '<span class="cc-badge b-mute">' + esc(r.tool || "any") + "</span><code title=\"" + esc(r.pattern) + '">' + esc(r.pattern) + "</code>" + btns + "</div>" +
        (r.note ? "<p>" + esc(r.note) + "</p>" : "") + '<div class="meta">' + scope + (meta.length ? "<span>· " + esc(meta.join(" · ")) + "</span>" : "") + "</div></li>";
    }
    function tryResHTML() {
      var r = P.tryRes;
      if (!r) return 'Type a command and press Test to see what the gate would do.';
      if (r.error) return '<span class="cc-muted">Could not test: ' + esc(r.error) + "</span>";
      var dec = r.decision === "none" ? "runs (no rule, harmless)" : r.decision === "allow" ? "runs without asking" : r.decision === "deny" ? "is refused" : "asks you first";
      var h = effBadge(r.decision === "none" ? "allow" : r.decision).replace(/>[^<]*</, ">" + esc(r.decision) + "<") + " <b>" + esc(dec) + "</b>";
      if (r.rule) h += " — matches " + (r.rule.builtin ? "built-in " : "") + "rule <code>" + esc(r.rule.pattern) + "</code>";
      else if (r.source === "classifier" && r.classifier) h += " — no rule matches; the classifier says <b>" + esc(r.classifier.label || r.classifier.category || "") + "</b>" + (r.classifier.destructive ? " (destructive)" : "");
      if (r.explain) h += '<br><span class="cc-muted">' + esc(r.explain) + "</span>";
      return h;
    }
    function watcherRow(w) {
      var th = w.threshold && typeof w.threshold === "object" ? Object.keys(w.threshold).map(function (k) { return k.replace(/_/g, " ") + " " + w.threshold[k]; }).join(" · ") : "";
      return '<div class="cc-watch-row' + (w.enabled ? "" : " off") + '" data-watch="' + esc(w.key) + '"><b>' + esc(w.name || w.key) + '</b><button type="button" class="cc-tgl" role="switch" aria-checked="' + !!w.enabled + '" aria-label="' + esc((w.enabled ? "Turn off " : "Turn on ") + (w.name || w.key)) + '" data-wkey="' + esc(w.key) + '"></button>' +
        "<small>" + esc(w.description || "") + "</small>" +
        '<div class="meta"><span class="cc-badge b-mute">this VPS</span>' + (w.state_text ? '<span class="cc-badge ' + (w.enabled ? "b-ok" : "b-mute") + '">' + esc(w.state_text) + "</span>" : "") +
        (w.action ? "<span>then: " + esc(w.action) + " ·</span>" : "") + "<span>" + esc((w.fired_24h ? "fired " + w.fired_24h + "× in 24 h" : "quiet in 24 h") + (w.last_fired_at ? " · last " + hm(w.last_fired_at) : "") + (th ? " · " + th : "")) + "</span></div></div>";
    }
    function renderRules(force) {
      var pane = $("cc-rules-pane");
      if (S.pane !== "rules" && !force) { P.rulesPending = true; return; }
      var ae = document.activeElement;
      if (!force && ae && pane.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && P.rulesPending !== "now") { P.rulesPending = true; return; }
      P.rulesPending = false;
      var sub = P.rulesSub;
      var nr = P.rules.length, nw = P.watchers.length, no = P.orders.length;
      var h = '<div class="cc-subseg" role="tablist"><button type="button" role="tab" data-sub="rules" aria-selected="' + (sub === "rules") + '">Approval rules · ' + nr + '</button><button type="button" role="tab" data-sub="watch" aria-selected="' + (sub === "watch") + '">System alerts · ' + nw + '</button><button type="button" role="tab" data-sub="orders" aria-selected="' + (sub === "orders") + '">Schedules · ' + no + "</button></div>";
      // Schedules (the standing orders, their own sheet until 2026-10-25) keep their list below this pane.
      var ow = $("cc-orders-wrap");
      if (ow) ow.hidden = sub !== "orders";
      if (sub === "rules") {
        h += '<div class="cc-sec-t">Test a command</div><div class="cc-try"><input class="cc-in cc-mono" id="cc-try-in" maxlength="2000" placeholder="systemctl restart odoo" aria-label="Test a command against the rules" value="' + esc(P.tryText) + '">' +
          '<div class="cc-chips-sel sm" data-try-tool><button type="button" data-v="Bash" aria-pressed="' + (P.tryTool === "Bash") + '">Bash</button><button type="button" data-v="SendMessage" aria-pressed="' + (P.tryTool === "SendMessage") + '">Send</button></div>' +
          '<button type="button" class="cc-btn sm" id="cc-try-btn">Test</button></div><div class="cc-try-res" id="cc-try-res">' + tryResHTML() + "</div>";
        h += '<div class="cc-sec-t">Rules<span class="cc-muted">scope: JOYA AI · this VPS</span></div>';
        if (P.err.rules) h += '<div class="cc-dec-empty">Rules are not available: ' + esc(P.err.rules) + "</div>";
        h += '<ul class="cc-rules">' + P.rules.map(ruleRow).join("") + "</ul>";
        h += P.addRule ? '<div class="cc-rule edit cc-add-rule">' + ruleForm(null) + "</div>" : '<div class="cc-add-rule"><button type="button" class="cc-btn sm" data-ract="add">' + ic("plus") + "Add a rule</button></div>";
        h += '<p class="cc-rule-hint"><b>Order:</b> Deny wins; built-in asks can\'t be overridden; then the most specific of your rules; with no match the classifier asks for anything destructive. Rules apply to JOYA AI\'s own gate on this VPS. “Always allow this” on an approval card adds one here.</p>';
      } else if (sub === "watch") {
        if (P.err.watchers) h += '<div class="cc-dec-empty">System alerts are not available: ' + esc(P.err.watchers) + "</div>";
        h += P.watchers.map(watcherRow).join("") || (P.err.watchers ? "" : '<div class="cc-dec-empty">No system alerts yet.</div>');
        h += '<p class="cc-rule-hint">A system alert listens to this VPS\'s events. When one fires, JOYA AI looks into it and puts a card in Decisions; it acts only after you approve.</p>';
      } else {
        h += '<p class="cc-rule-hint">Standing orders run on a schedule, as JOYA AI or a session.</p>';
      }
      pane.innerHTML = h;
    }
    function readRuleForm(form) {
      function pick(name) { var b = form.querySelector('[data-rf="' + name + '"] [aria-pressed="true"]'); return b ? b.getAttribute("data-v") : null; }
      return { effect: pick("effect"), tool: pick("tool"), pattern: form.querySelector("[data-rf-pat]").value.trim(), note: form.querySelector("[data-rf-note]").value.trim() };
    }
    function runTest() {
      var inp = $("cc-try-in");
      P.tryText = inp ? inp.value : P.tryText;
      if (!P.tryText.trim()) { P.tryRes = null; $("cc-try-res").innerHTML = tryResHTML(); return; }
      $("cc-try-res").textContent = "Testing…";
      api("rules/test", { body: { command: P.tryText, tool: P.tryTool } }).then(function (r) { P.tryRes = r; }).catch(function (e) { P.tryRes = { error: errText(e) }; })
        .then(function () { if ($("cc-try-res")) $("cc-try-res").innerHTML = tryResHTML(); });
    }
    $("cc-rules-pane").addEventListener("click", function (e) {
      var sb = e.target.closest("[data-sub]");
      if (sb) { P.rulesSub = sb.getAttribute("data-sub"); renderRules(true); return; }
      var chip = e.target.closest("[data-rf] button, [data-try-tool] button");
      if (chip) {
        var grp = chip.parentNode.querySelectorAll("button");
        for (var i = 0; i < grp.length; i++) grp[i].setAttribute("aria-pressed", String(grp[i] === chip));
        if (chip.closest("[data-try-tool]")) { P.tryTool = chip.getAttribute("data-v"); }
        return;
      }
      if (e.target.closest("#cc-try-btn")) { runTest(); return; }
      var t = e.target.closest("[data-wkey]");
      if (t) { toggleWatcher(t); return; }
      var a = e.target.closest("[data-ract]");
      if (!a) return;
      var act = a.getAttribute("data-ract"), rid = a.getAttribute("data-rid");
      var rule = null;
      P.rules.forEach(function (r) { if (String(r.id) === rid) rule = r; });
      if (act === "add") { P.addRule = true; P.editRule = null; renderRules(true); var f = $("cc-rules-pane").querySelector(".cc-add-rule [data-rf-pat]"); if (f) f.focus(); return; }
      if (act === "edit" && rule) { P.editRule = rule.id; P.addRule = false; renderRules(true); return; }
      if (act === "cancel") { P.editRule = null; P.addRule = false; renderRules(true); return; }
      if (act === "delete" && rule) { P.confirmDel = rule.id; renderRules(true); return; }
      if (act === "delete-no") { P.confirmDel = null; renderRules(true); return; }
      if (act === "delete-yes" && rule) {
        a.disabled = true;
        api("rules/" + encodeURIComponent(rule.id) + "/delete", { body: {} }).then(function () {
          P.rules = P.rules.filter(function (r) { return r.id !== rule.id; });
          P.confirmDel = null;
          renderRules(true);
          toast("Rule deleted.");
        }).catch(function (ex) { a.disabled = false; toast("Not deleted: " + errText(ex), true); });
        return;
      }
      if (act === "save") {
        var form = a.closest("[data-rule-form]"), v = readRuleForm(form), id = form.getAttribute("data-rule-form");
        var errEl = form.querySelector("[data-rf-err]");
        if (!v.pattern) { errEl.textContent = "Write a pattern."; return; }
        a.disabled = true;
        var body = { effect: v.effect || "allow", tool: v.tool || "Bash", pattern: v.pattern, note: v.note };
        api(id ? "rules/" + encodeURIComponent(id) : "rules", { body: body }).then(function (r) {
          P.editRule = null; P.addRule = false;
          if (r && r.rule) { P.newRule = r.rule.id; upsertRule(r.rule, true); }
          renderRules(true);
          toast(id ? "Rule saved." : "Rule added.");
        }).catch(function (ex) { a.disabled = false; errEl.textContent = "Not saved: " + errText(ex); });
      }
    });
    $("cc-rules-pane").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.id === "cc-try-in") { e.preventDefault(); runTest(); }
    });
    $("cc-rules-pane").addEventListener("input", function (e) { if (e.target.id === "cc-try-in") P.tryText = e.target.value; });
    $("cc-rules-pane").addEventListener("focusout", function () { setTimeout(function () { if (P.rulesPending === true && !$("cc-rules-pane").contains(document.activeElement)) renderRules(); }, 0); });
    function toggleWatcher(btn) {
      var key = btn.getAttribute("data-wkey"), on = btn.getAttribute("aria-checked") !== "true";
      btn.disabled = true;
      api("watchers/" + encodeURIComponent(key), { body: { enabled: on } }).then(function (r) {
        if (r && r.watcher) upsertWatcher(r.watcher);
        toast((on ? "Watching: " : "Stopped watching: ") + ((r && r.watcher && r.watcher.name) || key));
      }).catch(function (e) { btn.disabled = false; toast("Not changed: " + errText(e), true); });
    }
    function upsertWatcher(w) {
      if (!w) return;
      var i = P.watchers.findIndex(function (x) { return x.key === w.key; });
      if (i >= 0) P.watchers[i] = w; else P.watchers.push(w);
      if (S.status && S.status.counts) {
        S.status.counts.watchers_on = P.watchers.filter(function (x) { return x.enabled; }).length;
        S.status.counts.watchers_total = P.watchers.length;
      }
      CC.renderRail();
      renderRules();
    }

    /* ======================================================== standing orders */

    function orderById(id) {
      for (var i = 0; i < P.orders.length; i++) if (String(P.orders[i].id) === String(id)) return P.orders[i];
      return null;
    }
    /** A future time in words: today's is HH:MM, later ones carry the day. */
    function whenText(iso) {
      var d = iso ? new Date(iso) : null;
      if (!d || !isFinite(d)) return "";
      var today = CC.fmtDay.format(new Date());
      var day = CC.fmtDay.format(d);
      return day === today ? CC.fmtHM.format(d) : day + " " + CC.fmtHM.format(d);
    }
    function targetLabel(t) { return !t || t === "joya-ai" ? "JOYA AI" : t; }
    function renderOrders() {
      var el = $("cc-orders");
      if (P.rulesSub === "orders" && S.pane === "rules") renderRules(true);
      if (!P.orders.length) {
        el.innerHTML = '<li class="empty">' + esc(P.err.orders ? "Standing orders are not available: " + P.err.orders : "No standing orders yet. + New adds one: a morning briefing, say.") + "</li>";
        return;
      }
      el.innerHTML = P.orders.map(function (o) {
        var em = o.paused ? '<em class="p">paused</em>' : o.last_status === "running" ? '<em class="r">running</em>' : o.last_status === "ok" ? '<em class="ok">last ok</em>' : o.last_status === "error" ? '<em class="w">failed</em>' : '<em class="p">new</em>';
        var nx = o.paused ? "" : whenText(o.next_run_at);
        return '<li data-order="' + esc(o.id) + '" class="' + (o.paused ? "paused" : "") + '" title="' + esc((o.label || "") + " · runs as " + targetLabel(o.target) + (o.next_run_at && !o.paused ? " · next " + whenText(o.next_run_at) : "")) + '" tabindex="0">' +
          '<span class="oi">' + ic(o.paused ? "pause" : /brief/i.test(o.name || "") ? "sun2" : "clock") + "</span><b>" + esc(o.name) + "</b>" +
          '<span class="nx">' + em + esc(nx) + "</span><small>" + esc((o.label || scheduleLabel(o)) + " · " + targetLabel(o.target)) + "</small></li>";
      }).join("");
    }
    $("cc-orders").addEventListener("click", function (e) { var li = e.target.closest("[data-order]"); if (li) openOrder(li.getAttribute("data-order")); });
    $("cc-orders").addEventListener("keydown", function (e) { if (e.key === "Enter") { var li = e.target.closest("[data-order]"); if (li) openOrder(li.getAttribute("data-order")); } });
    function upsertOrder(o) {
      if (!o) return;
      var i = P.orders.findIndex(function (x) { return String(x.id) === String(o.id); });
      if (i >= 0) P.orders[i] = o; else P.orders.push(o);
      renderOrders();
      if (OV.ed && String(OV.ed.id) === String(o.id)) { OV.ed.order = o; renderOrderFoot(); }
    }

    var KINDS = [["daily", "Every day"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["hours", "Every N hours"], ["cron", "Cron"]];
    function openOrder(id) {
      var o = id != null ? orderById(id) : null;
      if (id != null && !o) { toast("That standing order is gone.", true); return; }
      var ed = {
        id: o ? o.id : null, order: o,
        name: o ? o.name : "", kind: o ? o.kind || "daily" : "daily", at: o ? o.at || "07:30" : "07:30", dow: o && o.dow != null ? o.dow : 1,
        every_h: o && o.every_h ? o.every_h : 6, cron: o ? o.cron || "" : "", target: o ? o.target || "joya-ai" : "joya-ai",
        prompt: o ? o.prompt || "" : "", paused: o ? !!o.paused : false, runs: null, confirmDel: false,
      };
      overlay("order",
        '<div class="cc-mh">' + ic("clock") + '<div class="cc-min0"><h2>' + (o ? "Standing order · " + esc(o.name) : "New standing order") + '</h2><small>Runs on its own schedule (' + esc(P.ordersTz) + "). The result lands in the conversation as a briefing card.</small></div>" +
        '<div class="cc-sp"><button type="button" class="cc-iconbtn" data-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></div>" +
        '<div class="cc-mb-body"><div class="cc-twocol"><div id="cc-ord-form"></div><div id="cc-ord-side"></div></div></div>' +
        '<div class="cc-mf" id="cc-ord-foot"></div>',
        "cc-modal wide", o ? "Standing order " + o.name : "New standing order");
      OV.ed = ed;
      renderOrderForm();
      renderOrderSide();
      renderOrderFoot();
      var nm = $("cc-ord-name");
      if (nm) nm.focus();
      if (o) {
        api("orders/" + encodeURIComponent(o.id) + "/runs").then(function (r) {
          if (OV.ed !== ed) return;
          ed.runs = (r && r.runs) || [];
          renderOrderSide();
        }).catch(function (e) { if (OV.ed === ed) { ed.runs = { error: errText(e) }; renderOrderSide(); } });
      }
      $("cc-ov").addEventListener("click", orderClick);
      $("cc-ov").addEventListener("input", orderInput);
    }
    function syncEd() {
      var ed = OV.ed;
      if (!ed) return;
      function v(id) { var el = $(id); return el ? el.value : null; }
      if (v("cc-ord-name") != null) ed.name = v("cc-ord-name");
      if (v("cc-ord-at") != null) ed.at = v("cc-ord-at");
      if (v("cc-ord-every") != null) ed.every_h = parseInt(v("cc-ord-every"), 10) || 1;
      if (v("cc-ord-cron") != null) ed.cron = v("cc-ord-cron");
      if (v("cc-ord-prompt") != null) ed.prompt = v("cc-ord-prompt");
    }
    function renderOrderForm() {
      var ed = OV.ed;
      if (!ed) return;
      var sch = { kind: ed.kind, at: ed.at, dow: ed.dow, every_h: ed.every_h, cron: ed.cron };
      var live = CC.sortSessions(CC.liveSessions()).filter(function (s) { return s.name; });
      var targets = [["joya-ai", "JOYA AI itself"]].concat(live.map(function (s) { return [s.name, s.name]; }));
      if (ed.target !== "joya-ai" && !targets.some(function (x) { return x[0] === ed.target; })) targets.push([ed.target, ed.target + " (not running)"]);
      var tg = P.telegram || { available: false, why: "Telegram delivery comes later." };
      var h = '<div class="cc-form">' +
        '<label for="cc-ord-name">Name</label><input class="cc-in" id="cc-ord-name" maxlength="120" placeholder="Morning briefing" value="' + esc(ed.name) + '">' +
        '<label>Schedule</label><div class="cc-chips-sel" data-ord="kind">' + KINDS.map(function (k) { return '<button type="button" data-v="' + k[0] + '" aria-pressed="' + (ed.kind === k[0]) + '">' + k[1] + "</button>"; }).join("") + "</div>";
      if (ed.kind === "daily" || ed.kind === "weekdays" || ed.kind === "weekly") {
        if (ed.kind === "weekly") h += '<label>Day</label><div class="cc-chips-sel sm" data-ord="dow">' + DOW.map(function (d, i) { return '<button type="button" data-v="' + i + '" aria-pressed="' + (Number(ed.dow) === i) + '">' + d.slice(0, 3) + "</button>"; }).join("") + "</div>";
        h += '<label for="cc-ord-at">At</label><div class="inl"><input class="cc-in cc-mono sm" id="cc-ord-at" type="time" value="' + esc(ed.at) + '"><span class="cc-muted">' + esc(P.ordersTz) + "</span></div>";
      } else if (ed.kind === "hours") {
        h += '<label for="cc-ord-every">Every</label><div class="inl"><input class="cc-in cc-mono sm" id="cc-ord-every" type="number" min="1" max="24" step="1" value="' + esc(ed.every_h) + '"><span class="cc-muted">hours</span></div>';
      } else {
        h += '<label for="cc-ord-cron">Cron</label><input class="cc-in cc-mono" id="cc-ord-cron" maxlength="100" placeholder="30 7 * * 1-5" value="' + esc(ed.cron) + '"><span></span><span class="hint">minute hour day-of-month month day-of-week, in ' + esc(P.ordersTz) + "</span>";
      }
      h += '<span></span><div class="cc-words" id="cc-ord-words">' + esc(scheduleLabel(sch)) + "</div>" +
        '<label>Runs as</label><div class="cc-chips-sel" data-ord="target">' + targets.map(function (x) { return '<button type="button" data-v="' + esc(x[0]) + '" aria-pressed="' + (ed.target === x[0]) + '">' + (x[0] === "joya-ai" ? ic("core") : "") + esc(clip(x[1], 36)) + "</button>"; }).join("") + "</div>" +
        (ed.target !== "joya-ai" ? '<span></span><span class="hint">JOYA AI delegates the prompt to that session and relays its answer.</span>' : "") +
        '<label class="top" for="cc-ord-prompt">What to do</label><textarea class="cc-in" id="cc-ord-prompt" rows="8" maxlength="8000" placeholder="Check the services, disk and memory on this box and failed sign-ins overnight. Five lines at most; lead with anything that needs me.">' + esc(ed.prompt) + "</textarea>" +
        '<label>Deliver to</label><div class="cc-chips-sel"><button type="button" aria-pressed="true" disabled title="Always delivered here">' + ic("check") + "Command Center</button>" +
        '<button type="button" aria-pressed="false" disabled title="' + esc(tg.available ? "Telegram" : tg.why || "Not available yet") + '">Telegram</button></div>' +
        (tg.available ? "" : '<span></span><span class="hint">Telegram: ' + esc(tg.why || "not available yet") + "</span>") +
        "</div>";
      $("cc-ord-form").innerHTML = h;
    }
    function runRow(r) {
      var st = r.status === "ok" ? "b-ok" : r.status === "error" ? "b-bad" : "b-work";
      return "<li><time>" + esc(whenText(r.started_at || r.scheduled_for)) + "</time><span>" + esc(clip(CC.plain(r.result || (r.status === "running" ? "running…" : "")), 140)) + (r.manual ? " (run now)" : "") + '</span><span class="cc-badge ' + st + '">' + esc(r.status) + "</span></li>";
    }
    function renderOrderSide() {
      var ed = OV.ed;
      if (!ed || !$("cc-ord-side")) return;
      var o = ed.order;
      var h = '<div class="cc-sec-t">Latest result' + (o && o.last_run_at ? '<span class="cc-muted">' + esc(whenText(o.last_run_at)) + "</span>" : "") + "</div>";
      if (o && o.last_result) {
        h += '<div class="cc-brief"><div class="cc-brief-h">' + ic("sun2") + "<b>" + esc(o.name) + "</b><span>" + esc(o.label || "") + '</span></div><div class="cc-brief-b cc-bubble cc-preview">' + CC.md(o.last_result) + "</div></div>";
      } else {
        h += '<div class="cc-callout">' + (o ? "It has not reported yet. Run now to see a result." : "Save it, then Run now to see its first result here and in the conversation.") + "</div>";
      }
      if (o) {
        h += '<div class="cc-sec-t gap">Last runs' + (o.next_run_at && !o.paused ? '<span class="cc-muted">next ' + esc(whenText(o.next_run_at)) + "</span>" : "") + '</div><ul class="cc-runs">';
        if (!ed.runs) h += '<li class="empty">Loading…</li>';
        else if (ed.runs.error) h += '<li class="empty">Could not load the runs: ' + esc(ed.runs.error) + "</li>";
        else if (!ed.runs.length) h += '<li class="empty">No runs yet.</li>';
        else h += ed.runs.slice(0, 20).map(runRow).join("");
        h += "</ul>";
      }
      $("cc-ord-side").innerHTML = h;
    }
    function renderOrderFoot() {
      var ed = OV.ed;
      if (!ed || !$("cc-ord-foot")) return;
      var o = ed.order;
      var h = "";
      if (o) {
        h += '<button type="button" class="cc-btn" data-oact="pause">' + ic(o.paused ? "play" : "pause") + (o.paused ? "Resume" : "Pause") + "</button>" +
          '<button type="button" class="cc-btn" data-oact="run">' + ic("play") + "Run now</button>" +
          (ed.confirmDel ? '<button type="button" class="cc-btn danger" data-oact="delete-yes">' + ic("trash") + 'Delete it</button><button type="button" class="cc-btn" data-oact="delete-no">Keep</button>'
            : '<button type="button" class="cc-btn" data-oact="delete">' + ic("trash") + "Delete</button>");
      }
      h += '<span class="cc-err" id="cc-ord-err"></span><div class="cc-sp"><button type="button" class="cc-btn" data-close>Cancel</button><button type="button" class="cc-btn pri" data-oact="save">' + ic("check") + "Save</button></div>";
      $("cc-ord-foot").innerHTML = h;
    }
    function orderInput(e) {
      var ed = OV.ed;
      if (!ed) return;
      syncEd();
      if (e.target.id === "cc-ord-at" || e.target.id === "cc-ord-every" || e.target.id === "cc-ord-cron") {
        $("cc-ord-words").textContent = scheduleLabel({ kind: ed.kind, at: ed.at, dow: ed.dow, every_h: ed.every_h, cron: ed.cron });
      }
    }
    function orderClick(e) {
      var ed = OV.ed;
      if (!ed) return;
      var chip = e.target.closest("[data-ord] button");
      if (chip && !chip.disabled) {
        syncEd();
        var grp = chip.closest("[data-ord]").getAttribute("data-ord"), v = chip.getAttribute("data-v");
        if (grp === "kind") ed.kind = v;
        if (grp === "dow") ed.dow = Number(v);
        if (grp === "target") ed.target = v;
        renderOrderForm();
        return;
      }
      var b = e.target.closest("[data-oact]");
      if (!b || b.disabled) return;
      var act = b.getAttribute("data-oact"), o = ed.order;
      function fail(ex) { b.disabled = false; if ($("cc-ord-err")) $("cc-ord-err").textContent = "Not done: " + errText(ex); }
      if (act === "save") {
        syncEd();
        if (!ed.name.trim()) { $("cc-ord-err").textContent = "Give it a name."; return; }
        if (!ed.prompt.trim()) { $("cc-ord-err").textContent = "Say what it should do."; return; }
        if ((ed.kind === "daily" || ed.kind === "weekdays" || ed.kind === "weekly") && !/^\d{1,2}:\d{2}$/.test(ed.at)) { $("cc-ord-err").textContent = "Set a time, HH:MM."; return; }
        if (ed.kind === "cron" && !ed.cron.trim()) { $("cc-ord-err").textContent = "Write the cron expression."; return; }
        var sch = { kind: ed.kind };
        if (ed.kind === "daily" || ed.kind === "weekdays" || ed.kind === "weekly") sch.at = ed.at;
        if (ed.kind === "weekly") sch.dow = Number(ed.dow);
        if (ed.kind === "hours") sch.every_h = Math.max(1, Math.min(24, ed.every_h));
        if (ed.kind === "cron") sch.cron = ed.cron.trim();
        var body = { name: ed.name.trim(), schedule: sch, target: ed.target, prompt: ed.prompt, delivery: ["cc"], paused: !!ed.paused };
        b.disabled = true;
        api(o ? "orders/" + encodeURIComponent(o.id) : "orders", { body: body }).then(function (r) {
          if (r && r.order) upsertOrder(r.order);
          closeOverlay();
          toast(o ? "Standing order saved." : "Standing order added" + (r && r.order && r.order.next_run_at ? ": first run " + whenText(r.order.next_run_at) : "") + ".");
        }).catch(fail);
      } else if (act === "run" && o) {
        b.disabled = true;
        api("orders/" + encodeURIComponent(o.id) + "/run", { body: {} }).then(function (r) {
          if (r && r.order) upsertOrder(r.order);
          if (r && r.run && Array.isArray(ed.runs)) { ed.runs.unshift(r.run); renderOrderSide(); }
          b.disabled = false;
          toast("Running now. The result lands in the conversation.");
        }).catch(fail);
      } else if (act === "pause" && o) {
        b.disabled = true;
        api("orders/" + encodeURIComponent(o.id) + "/pause", { body: { paused: !o.paused } }).then(function (r) {
          if (r && r.order) { ed.paused = !!r.order.paused; upsertOrder(r.order); }
          toast(r && r.order && r.order.paused ? "Paused." : "Resumed.");
        }).catch(fail);
      } else if (act === "delete") { ed.confirmDel = true; renderOrderFoot(); }
      else if (act === "delete-no") { ed.confirmDel = false; renderOrderFoot(); }
      else if (act === "delete-yes" && o) {
        b.disabled = true;
        api("orders/" + encodeURIComponent(o.id) + "/delete", { body: {} }).then(function () {
          P.orders = P.orders.filter(function (x) { return String(x.id) !== String(o.id); });
          renderOrders();
          closeOverlay();
          toast("Standing order deleted.");
        }).catch(fail);
      }
    }

    /* ======================================================== usage */
    /*
     * The Usage sheet (key "cost", kept so sheet.open and old links still work).
     * First Claude plan usage exactly as Claude Code's /usage shows it -- the
     * supervisor asks the CLI itself (get_usage), nothing is estimated here --
     * then this box's own token counts from the transcripts, then the voice's
     * OpenAI spend, the only money on the sheet (billed separately).
     */

    function spark(vals, w, h, est) {
      vals = (vals || []).map(function (v) { return Number(v) || 0; });
      if (vals.length < 2) vals = [0].concat(vals.length ? vals : [0]);
      var mx = Math.max.apply(null, vals) || 1, st = w / (vals.length - 1);
      var pts = vals.map(function (v, i) { return (i * st).toFixed(1) + "," + (h - 2 - (v / mx) * (h - 4)).toFixed(1); });
      var last = vals[vals.length - 1];
      return '<svg class="cc-spark' + (est ? " est" : "") + '" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts.join(" ") + '" vector-effect="non-scaling-stroke"/><circle cx="' + ((vals.length - 1) * st).toFixed(1) + '" cy="' + (h - 2 - (last / mx) * (h - 4)).toFixed(1) + '" r="2.2"/></svg>';
    }
    var PU = window.JoyaPlanUsage;
    var TOK_KEYS = [["input", "Input"], ["output", "Output"], ["cache_read", "Cache read"], ["cache_write", "Cache write"]];
    P.usagePeriod = "today";
    function planBlock(u, opts) {
      opts = opts || {};
      var pl = u && u.plan, now = Date.now();
      var h = '<div class="cc-pu" aria-live="polite">';
      h += '<div class="cc-pu-h"><h3>Plan usage limits</h3>' + (pl && pl.plan && pl.plan.subscription_type ? '<span class="cc-badge b-mute">' + esc(PU.planName(pl.plan.subscription_type)) + " plan</span>" : "") + "</div>";
      if (!pl || !pl.plan) {
        h += '<div class="cc-callout warn">Plan usage is not available' + (pl && pl.error ? ": " + esc(pl.error) : P.err.usage ? ": " + esc(P.err.usage) : "") + ". Nothing is shown rather than a guess.</div></div>";
        return h;
      }
      var p = pl.plan;
      if (!p.available || !p.rows.length) h += '<div class="cc-callout">Plan limits do not apply to this login (API key or no plan): Claude Code shows none either.</div>';
      p.rows.forEach(function (r, i) {
        var pc = PU.pctUsed(r.utilization), prev = i ? p.rows[i - 1] : null;
        if (r.group === "weekly" && (!prev || prev.group !== "weekly")) h += '<div class="cc-pu-g">Weekly limits</div>';
        h += '<div class="cc-pu-row" data-k="' + esc(r.key) + '"><div class="cc-pu-t"><b>' + esc(r.title) + '</b><span class="cc-pu-n">' + esc(pc + "% used") + "</span></div>" +
          '<div class="cc-pu-bar" role="progressbar" aria-label="' + esc(r.title) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(Math.min(100, pc)) + '"><i class="' + (pc >= 100 ? "x" : pc >= 80 ? "w" : "") + '" data-w="' + esc(Math.min(100, r.utilization)) + '"></i></div>' +
          '<div class="cc-pu-r" title="' + esc(r.resets_at || "") + '">' + esc(r.resets_at ? "Resets " + PU.resetText(r.resets_at, r.always_date, now) : "No reset time given") + (r.resets_at ? '<span class="cc-muted"> · ' + esc(PU.inText(r.resets_at, now)) + "</span>" : "") + "</div></div>";
      });
      var src = pl.source === "probe" ? "Claude Code (a one-off check: JOYA AI was not running)" : "Claude Code's /usage, asked of JOYA AI's CLI";
      h += '<div class="cc-pu-f"><span id="cc-pu-asof">' + esc("as of " + hm(pl.fetched_at)) + "</span>" + (P.err.usage || (pl.stale && pl.error) ? '<span class="cc-err"> · not refreshed: ' + esc(P.err.usage || pl.error) + "</span>" : "") +
        '<span class="cc-muted" title="' + esc(src) + '"> · from ' + esc(pl.source === "probe" ? "Claude Code (one-off check)" : "Claude Code /usage") + "</span>" +
        (opts.refresh ? '<button type="button" class="cc-linkbtn" data-pu-refresh>' + ic("repeat") + "Refresh</button>" : "") + "</div>";
      return h + "</div>";
    }
    function tokenTotalsHTML(t) {
      return '<div class="cc-tk-sum">' + TOK_KEYS.map(function (k) { return '<div><b>' + esc(tokens(t[k[0]])) + "</b><span>" + esc(k[1]) + "</span></div>"; }).join("") + "</div>";
    }
    function stackBar(r, mx) {
      // One bar per session: its total against the largest, split by kind.
      var w = mx ? r.total / mx * 100 : 0, parts = "";
      TOK_KEYS.forEach(function (k) { if (r[k[0]]) parts += '<i class="k-' + k[0] + '" data-w="' + (r[k[0]] / (r.total || 1) * 100) + '"></i>'; });
      return '<span class="cc-tk-bar" data-w="' + w + '">' + parts + "</span>";
    }
    function periodSeg(cur) {
      return '<div class="cc-chips-sel cc-tk-seg" role="group" aria-label="Period">' + [["today", "Today"], ["week", "Last 7 days"]].map(function (x) {
        return '<button type="button" data-tk-period="' + x[0] + '" aria-pressed="' + (x[0] === cur) + '">' + x[1] + "</button>";
      }).join("") + "</div>";
    }
    function tokenSection(u, full) {
      var t = u && u.tokens;
      var h = '<div class="cc-tk"><div class="cc-pu-h"><h3>Tokens · counted on this box</h3>' + periodSeg(P.usagePeriod) + "</div>";
      if (!t) return h + '<div class="cc-empty-s">' + esc(P.err.usage ? "Token counts are not available: " + P.err.usage : "—") + "</div></div>";
      var per = t.periods[P.usagePeriod] || t.periods.today;
      h += '<p class="cc-rule-hint">Joya\'s own count from the Claude transcripts on this VPS' + (P.usagePeriod === "week" ? " (" + esc(t.periods.week.from + " – " + t.periods.week.to) + ")" : " (today, " + esc(t.tz || "Cairo") + ")") + ". Not plan figures: Claude weighs tokens differently for the limits above.</p>";
      h += '<div class="cc-tk-total"><b>' + esc(tokens(per.totals.total)) + "</b><span>tokens " + (P.usagePeriod === "week" ? "in the last 7 days" : "today") + "</span>" + spark(t.days.slice(-7).map(function (d) { return d.total; }), 76, 26) + "</div>";
      h += tokenTotalsHTML(per.totals);
      var rows = per.sessions;
      if (!rows.length) return h + '<div class="cc-empty-s">No Claude tokens counted ' + (P.usagePeriod === "week" ? "this week" : "today") + ".</div></div>";
      var mx = Math.max.apply(null, rows.map(function (r) { return r.total; })) || 1;
      if (!full) {
        h += '<div class="cc-tk-rows">' + rows.slice(0, 6).map(function (r) {
          return '<div class="cc-tk-row" title="' + esc(r.name + ": in " + r.input + " · out " + r.output + " · cache read " + r.cache_read + " · cache write " + r.cache_write) + '"><span>' + esc(r.name) + (r.self ? ' <small class="cc-muted">CEO</small>' : "") + "</span>" + stackBar(r, mx) + "<b>" + esc(tokens(r.total)) + "</b></div>";
        }).join("") + "</div>";
        h += '<div class="cc-tk-legend">' + TOK_KEYS.map(function (k) { return '<span><i class="k-' + k[0] + '"></i>' + esc(k[1]) + "</span>"; }).join("") + "</div>";
      } else {
        h += '<table class="cc-tbl cc-tk-tbl"><tr><th>Session</th>' + TOK_KEYS.map(function (k) { return '<th class="n">' + esc(k[1]) + "</th>"; }).join("") + '<th class="n">Total</th></tr>' +
          rows.map(function (r) {
            return '<tr><td class="nm" title="' + esc(r.name + (r.session_count > 1 ? " · " + r.session_count + " session ids" : "")) + '">' + esc(r.name) + (r.self ? ' <small>CEO</small>' : "") + "</td>" + TOK_KEYS.map(function (k) { return '<td class="n">' + esc(PU.fullNum(r[k[0]])) + "</td>"; }).join("") + '<td class="n"><b>' + esc(PU.fullNum(r.total)) + "</b></td></tr>";
          }).join("") +
          '<tr class="tot"><td class="nm">All sessions</td>' + TOK_KEYS.map(function (k) { return '<td class="n">' + esc(PU.fullNum(per.totals[k[0]])) + "</td>"; }).join("") + '<td class="n"><b>' + esc(PU.fullNum(per.totals.total)) + "</b></td></tr></table>";
      }
      return h + "</div>";
    }
    function renderCostWidget() {
      var el = $("cc-cost-widget");
      if (!el) return;
      el.innerHTML = planBlock(P.usage, { refresh: true }) + tokenSection(P.usage, false);
      CC.applyBars(el);
    }
    /* ---- the voice's own spend (OpenAI), from the usage OpenAI reports for
       every call, priced on the server. Today and this month (Cairo), split by
       kind of turn, transcription on its own line, and the last turn. The only
       money on the sheet: OpenAI bills it, separately from the Claude plan. ---- */
    // The last three are the front desk's (removed 2026-09-30: voice is live conversation only):
    // shown only while this month still has spend on them.
    var VU_ROWS = [
      ["live", "Live", "The live conversation: the realtime model's audio in and out, and JOYA AI's summaries read into the call"],
      ["direct", "Read aloud", "JOYA AI's replies read aloud word for word"],
      ["sample", "Voice samples", "Settings ▸ Voice: a voice card's play button (each clip is made once and kept)", true],
      ["small_talk", "Small talk", "The old front desk's small talk", true],
      ["snapshot", "Snapshot", "The old front desk's answers from the read-only snapshot", true],
      ["handoff", "Hand-offs", "The old front desk's hand-offs and their spoken summaries", true],
    ];
    var VU_CAT = { small_talk: "small talk", snapshot: "snapshot answer", handoff: "hand-off", direct: "read aloud", live: "live conversation", sample: "voice sample" };
    function vmoney(n) {
      n = Number(n) || 0;
      if (!n) return "$0";
      return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
    }
    function renderVoiceUsage() {
      var el = $("cc-voice-usage");
      if (!el) return;
      var sum = $("cc-vu-sum");
      var u = P.voiceUsage;
      if (!u || !u.today) {
        if (sum) sum.textContent = "";
        el.innerHTML = '<div class="cc-empty-s">Voice usage ' + esc(P.err.voiceUsage ? "is not available: " + P.err.voiceUsage : "—") + "</div>";
        return;
      }
      var t = u.today, m = u.month_totals || {}, last = u.last;
      if (sum) sum.textContent = vmoney(t.total) + " today";
      var h = '<div class="cc-vu-h"><span class="cc-vu-k">Voice · OpenAI</span><span class="cc-vu-n">' + esc((t.turns || 0) + " turn" + (t.turns === 1 ? "" : "s") + " today") + "</span></div>";
      h += '<div class="cc-vu-t" role="table" aria-label="Voice spend, today and this month"><span role="columnheader"></span><span class="n" role="columnheader">today</span><span class="n" role="columnheader">month</span>';
      VU_ROWS.forEach(function (r) {
        if (r[3] && !Number(t.by[r[0]]) && !Number(m.by ? m.by[r[0]] : 0)) return;
        h += '<span class="l" role="rowheader" title="' + esc(r[2]) + '">' + esc(r[1]) + '</span><span class="n" role="cell">' + esc(vmoney(t.by[r[0]])) + '</span><span class="n" role="cell">' + esc(vmoney(m.by ? m.by[r[0]] : 0)) + "</span>";
      });
      h += '<span class="l" role="rowheader" title="What you said, turned into text (every path)">Transcription</span><span class="n" role="cell">' + esc(vmoney(t.transcription)) + '</span><span class="n" role="cell">' + esc(vmoney(m.transcription)) + "</span>";
      h += '<span class="l tot" role="rowheader">Voice total</span><span class="n tot" role="cell" id="cc-vu-today">' + esc(vmoney(t.total)) + '</span><span class="n tot" role="cell" id="cc-vu-month">' + esc(vmoney(m.total)) + "</span></div>";
      h += last
        ? '<div class="cc-vu-last" id="cc-vu-last" title="The last voice turn: transcription ' + esc(vmoney(last.parts.transcription)) + ", summary " + esc(vmoney(last.parts.desk)) + ", speech " + esc(vmoney(last.parts.speech)) + (last.parts.realtime ? ", live " + esc(vmoney(last.parts.realtime)) : "") + '">Last turn <b>' + esc(vmoney(last.usd)) + "</b> · " + esc(VU_CAT[last.cat] || last.cat) + "</div>"
        : '<div class="cc-vu-last" id="cc-vu-last">No voice turns yet</div>';
      h += '<div class="cc-vu-f" title="' + esc("Priced from the usage OpenAI reports for each call, at the prices on " + ((u.prices && u.prices.source) || "OpenAI's pricing page")) + '">' + esc("OpenAI usage · prices of " + ((u.prices && u.prices.read) || "")) + "</div>";
      el.innerHTML = h;
    }
    function setVoiceUsage(u) {
      if (!u || !u.today) return;
      P.voiceUsage = u;
      delete P.err.voiceUsage;
      renderVoiceUsage();
    }
    function loadVoiceUsage() {
      if (!$("cc-voice-usage")) return Promise.resolve();
      return api("voice/usage").then(setVoiceUsage).catch(function (e) { P.err.voiceUsage = errText(e); renderVoiceUsage(); });
    }
    var usageBusy = false;
    function loadCost() {
      loadVoiceUsage();
      if (usageBusy) return Promise.resolve();
      usageBusy = true;
      return api("usage").then(function (u) { P.usage = u; delete P.err.usage; }).catch(function (e) { P.err.usage = errText(e); })
        .then(function () { usageBusy = false; renderCostWidget(); if (OV.kind === "cost") renderCostBody(); });
    }
    // Opening the sheet refreshes it (the server reuses an answer under a minute old).
    (function () {
      var pane = $("cc-pane-cost");
      if (!pane || !window.MutationObserver) return;
      new MutationObserver(function () { if (!pane.hidden) loadCost(); }).observe(pane, { attributes: true, attributeFilter: ["hidden"] });
    })();
    function openCost() {
      overlay("cost",
        '<div class="cc-mh">' + ic("gauge") + '<div class="cc-min0"><h2>Usage</h2><small>Claude plan limits as Claude Code\'s /usage shows them, and the tokens every session on this VPS used, per session and per day.</small></div><div class="cc-sp"><button type="button" class="cc-iconbtn" data-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></div>" +
        '<div class="cc-mb-body" id="cc-cost-body"><div class="cc-empty-s">Loading…</div></div>',
        "cc-modal wide", "Usage");
      if (P.usage) renderCostBody();
      loadCost();
    }
    function renderCostBody() {
      var el = $("cc-cost-body");
      if (!el) return;
      var u = P.usage;
      if (!u) { el.innerHTML = '<div class="cc-callout warn">Usage is not available: ' + esc(P.err.usage || "no data") + "</div>"; return; }
      var h = '<div class="cc-twocol cc-usage-2"><div>' + planBlock(u, { refresh: true });
      var t = u.tokens;
      if (t && t.days && t.days.length) {
        // Tokens per day: input + output + cache, stacked, from the transcripts.
        var w = 640, hh = 150, n = t.days.length, bw = w / n;
        var mx = Math.max.apply(null, t.days.map(function (d) { return d.total; }).concat([1]));
        var sc = (hh - 30) / (mx * 1.08);
        var bars = t.days.map(function (d, i) {
          var x = (i * bw + 5).toFixed(1), bwid = Math.max(2, bw - 10).toFixed(1), y = hh - 18, out = "";
          TOK_KEYS.forEach(function (k) {
            var v = (d[k[0]] || 0) * sc;
            if (v <= 0) return;
            y -= v;
            out += '<rect class="cc-tkb k-' + k[0] + (i === n - 1 ? " today" : "") + '" x="' + x + '" y="' + y.toFixed(1) + '" width="' + bwid + '" height="' + v.toFixed(1) + '"><title>' + esc(d.day + " · " + k[1] + ": " + PU.fullNum(d[k[0]])) + "</title></rect>";
          });
          var dt = new Date(d.day + "T12:00:00Z");
          return out + '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (hh - 4) + '" text-anchor="middle">' + esc(isFinite(dt) ? String(dt.getUTCDate()) : "") + "</text>";
        }).join("");
        h += '<div class="cc-sec-t gap">Tokens per day · last ' + n + ' days<span class="cc-muted">counted on this box</span></div><div class="cc-bars"><svg viewBox="0 0 ' + w + " " + hh + '" preserveAspectRatio="none" aria-label="Tokens per day">' + bars + "</svg></div>" +
          '<div class="cc-tk-legend">' + TOK_KEYS.map(function (k) { return '<span><i class="k-' + k[0] + '"></i>' + esc(k[1]) + "</span>"; }).join("") + "</div>";
      }
      h += "</div><div>" + tokenSection(u, true) + '<p class="cc-rule-hint">' + esc((t && t.note) || "") + (t && t.scanned_at ? " Last read " + esc(hm(t.scanned_at)) + "." : "") + "</p></div></div>";
      el.innerHTML = h;
      CC.applyBars(el);
    }
    function usageClick(e) {
      var b = e.target.closest("[data-tk-period]");
      if (b) {
        P.usagePeriod = b.getAttribute("data-tk-period") === "week" ? "week" : "today";
        renderCostWidget();
        if (OV.kind === "cost") renderCostBody();
        return;
      }
      if (e.target.closest("[data-pu-refresh]")) loadCost();
    }
    document.getElementById("cc-overlay").addEventListener("click", function (e) { if (OV.kind === "cost") usageClick(e); });
    (function () {
      var w = $("cc-cost-widget");
      if (w) w.addEventListener("click", usageClick);
      // The voice block stays as this viewer left it (open or closed).
      var vb = $("cc-vu-box");
      if (!vb) return;
      try { if (localStorage.getItem("cc.vu.open") === "1") vb.open = true; } catch (e) { /* no storage */ }
      vb.addEventListener("toggle", function () { try { localStorage.setItem("cc.vu.open", vb.open ? "1" : "0"); } catch (e) { /* no storage */ } });
    })();

    /* ======================================================== deep view */

    function deepToldHTML(dels, s) {
      if (s && s.self) return '<div class="cc-told">This is JOYA AI itself: it is the one delegating. Its own conversation is in the Conversation sheet.</div>';
      if (!dels || !dels.length) return '<div class="cc-told">JOYA AI has not delegated anything to this session.</div>';
      // The whole text of every message JOYA AI sent, newest first: never clipped, escaped, scrolling in its own box.
      return '<div class="cc-told">' + dels.slice().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); }).map(function (d) {
        return '<span class="h">' + esc(hm(d.created_at)) + " · " + esc(CC.TL_LAB[d.status] || d.status || "") + "</span>" + esc(d.text || d.summary || "");
      }).join("\n") + "</div>";
    }
    function deepEntry(e, s) {
      var tm = esc(hm(e.t));
      if (e.role === "tool") return '<div class="cc-msg sys"><div class="cc-bubble">' + ic("terminal") + " " + esc(e.tool ? e.tool + " · " : "") + esc(clip(e.text, 300)) + " · " + tm + "</div></div>";
      if (e.role === "user") return '<div class="cc-msg me"><div class="who"><b>User</b> · ' + tm + '</div><div class="cc-bubble">' + esc(clip(e.text, 4000)) + "</div></div>";
      if (e.role === "peer") return '<div class="cc-msg me"><div class="who"><span class="cc-av"></span><b>JOYA AI</b> (delegation) · ' + tm + '</div><div class="cc-bubble">' + esc(clip(e.text, 4000)) + "</div></div>";
      return '<div class="cc-msg ai"><div class="who"><b>' + esc(s.self ? "JOYA AI" : s.name || "Session") + "</b> · " + tm + '</div><div class="cc-bubble">' + CC.md(clip(e.text, 6000)) + "</div></div>";
    }
    function openDeep(key, opt) {
      // Opening a session shows its story (cc-story.js); the story's "Live mirror" comes back here with { mirror: true }.
      if (!(opt && opt.mirror) && window.JoyaStory && window.JoyaStory.openKey(key)) return;
      var s = CC.findSess(key);
      if (!s) return;
      overlay("deep", '<div id="cc-deep-in"></div>', "cc-deep", "Session " + (s.self ? "JOYA AI" : s.name || ""));
      OV.deep = { key: key, data: null, err: null, at: null };
      renderDeep();
      fetchDeep();
      OV.timer = setInterval(function () { if (!document.hidden) fetchDeep(); }, 5000);
      $("cc-ov").addEventListener("click", deepClick);
    }
    function fetchDeep() {
      var dv = OV.deep;
      if (!dv) return;
      var s = CC.findSess(dv.key);
      var sid = s && s.session_id;
      if (!sid) { dv.err = s ? "This session has no id yet, so there is no mirror to read." : "This session is no longer running."; renderDeep(); return; }
      api("sessions/" + encodeURIComponent(sid) + "/mirror").then(function (r) {
        if (OV.deep !== dv) return;
        dv.data = r; dv.err = null; dv.at = new Date().toISOString();
        renderDeep();
      }).catch(function (e) {
        if (OV.deep !== dv) return;
        dv.err = errText(e);
        renderDeep();
      });
    }
    function renderDeep() {
      var dv = OV.deep, box = $("cc-deep-in");
      if (!dv || !box) return;
      var s0 = CC.findSess(dv.key);
      var d = dv.data || {};
      var s = s0 || d.session || {};
      var name = s.self ? "JOYA AI" : s.name || "unnamed session";
      var st = s.self ? CC.selfState() : s0 ? CC.sessState(s) : "offline";
      var list = box.querySelector(".cc-mirror-list");
      var keepBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 40, keepTop = list ? list.scrollTop : 0;
      var toolList = d.tools_today || [];
      var running = toolList.length && toolList[toolList.length - 1].ok == null ? toolList[toolList.length - 1] : null;
      var now = running ? '<div class="cc-toolnow work"><span class="cc-spin"></span><b>NOW</b><code>' + esc(running.name + (running.summary ? " · " + running.summary : "")) + "</code><time>" + esc(CC.hms(running.t)) + "</time></div>"
        : s.waiting_for ? '<div class="cc-toolnow wait"><b>WAITING</b><span>' + esc(s.waiting_for) + "</span></div>"
        : '<div class="cc-toolnow"><b>NOW</b><span>' + esc(st + (s.status_since ? " since " + hm(s.status_since) : "")) + "</span></div>";
      var entries = (d.entries || []).map(function (e) { return deepEntry(e, s); }).join("");
      var subs = (d.session && d.session.subagents) || s.subagents || [];
      var cost = d.cost || null;
      var tags = (s.self ? '<span class="cc-badge b-self">' + ic("core") + "CEO</span>" : "") + (s.mission ? '<span class="cc-badge b-mis">' + ic("flag") + esc(s.mission.ref || "") + (s.mission.step_n ? " · step " + esc(s.mission.step_n) : "") + "</span>" : "") + '<span class="cc-badge b-mute">' + esc(CC.sessWhere(s)) + "</span>";
      var sub = [s.cwd || "", "pid " + (s.pid || "?"), "this VPS"];
      if (s.started_at) sub.push("since " + hm(s.started_at));
      var h = '<div class="cc-mh"><span class="cc-sc-ic">' + ic(CC.sessIcon(s)) + '</span><div class="cc-min0"><h2>' + esc(name) + " " + tags + '</h2><small class="cc-mono">' + esc(sub.filter(Boolean).join(" · ")) + "</small></div>" +
        '<div class="cc-sp"><span class="cc-state-pill' + (st === "working" ? " work" : st === "waiting" ? " warn" : st === "offline" ? " bad" : "") + '"><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : st === "offline" ? "off" : "idle") + '"></span>' + esc(st) + "</span>" +
        '<button type="button" class="cc-iconbtn" data-close title="Close (Esc)" aria-label="Close">' + ic("close") + "</button></div></div>";
      h += '<div class="cc-deep-body"><div class="cc-deep-col">' + now +
        '<div class="cc-mirror"><div class="cc-mirror-h">' + ic("eye") + "<b>Live mirror</b> · read-only · latest entries" + '<span class="r">' + (dv.err ? '<span class="cc-dot bad"></span>' + esc(clip(dv.err, 80)) : dv.at ? ic("bolt") + "updated " + esc(CC.hms(dv.at)) : "loading…") + "</span></div>" +
        '<div class="cc-mirror-list cc-scroll">' + (entries || '<div class="cc-empty-s">' + (dv.data ? "Nothing in its transcript yet." : dv.err ? "No mirror to show." : "Reading its transcript…") + "</div>") + "</div></div></div>";
      h += '<div class="cc-deep-col">' +
        '<div class="cc-box"><div class="cc-sec-t">Sub-agents · ' + subs.length + '<span class="cc-muted">moons on the map</span></div>' + (subs.length ? '<ul class="cc-subs">' + subs.map(function (a) { return '<li><span class="cc-dot work"></span><span>' + esc(CC.subagentLabel(a)) + "</span><time>" + esc(a.modified ? "active " + CC.ago(a.modified) : "") + "</time></li>"; }).join("") + "</ul>" : '<span class="cc-empty-s">none running</span>') + "</div>" +
        '<div class="cc-box"><div class="cc-sec-t">What JOYA AI told it · full text</div>' + deepToldHTML(d.delegations || (s.last_delegation ? [s.last_delegation] : []), s) + "</div>" +
        '<div class="cc-box grow"><div class="cc-sec-t">Tool calls today · ' + toolList.length + '</div><ul class="cc-tools cc-scroll">' +
        (toolList.length ? toolList.slice().reverse().map(function (x) { return '<li class="' + (x.ok === false ? "bad" : "") + '"><time>' + esc(hm(x.t)) + "</time>" + ic(x.ok === false ? "alert" : "terminal") + "<code title=\"" + esc(x.summary || "") + '">' + esc(x.name + (x.summary ? " · " + x.summary : "")) + "</code><em>" + esc(x.ok == null ? "running" : x.ok ? "ok" : "failed") + "</em></li>"; }).join("") : '<li class="empty">' + (dv.data ? "No tool calls today." : "…") + "</li>") + "</ul></div>" +
        '<div class="cc-box"><div class="cc-sec-t">Tokens today<span class="cc-muted">counted on this box</span></div><div class="cc-deep-cost"><div><b>' + esc(cost ? tokens((cost.today_in || 0) + (cost.today_out || 0)) : "—") + "</b><span>total</span></div><div><b>" + esc(cost ? tokens(cost.today_in) : "—") + "</b><span>in + cache</span></div><div><b>" + esc(cost ? tokens(cost.today_out) : "—") + "</b><span>out</span></div>" + (cost && cost.week_tokens ? spark(cost.week_tokens, 160, 30) : "<span></span>") + "</div></div>" +
        "</div></div>";
      h += '<div class="cc-deep-foot"><span class="cc-muted">' + ic("eye") + " Read-only view · refreshes every 5 s</span><div class=\"cc-sp\">" +
        (s.self ? (st === "working" ? '<button type="button" class="cc-btn" data-deep="interrupt">' + ic("stop") + "Interrupt</button>" : "") + '<button type="button" class="cc-btn pri" data-deep="rc">' + ic("open") + "Open in Claude Desktop</button>"
          : s0 && s.name ? '<button type="button" class="cc-btn pri" data-deep="send">' + ic("send") + "Send via JOYA AI…</button>" : "") +
        "</div></div>";
      box.innerHTML = h;
      var nl = box.querySelector(".cc-mirror-list");
      if (nl) nl.scrollTop = keepBottom ? nl.scrollHeight : keepTop;
    }
    function deepClick(e) {
      var b = e.target.closest("[data-deep]");
      if (!b || !OV.deep) return;
      var s = CC.findSess(OV.deep.key), act = b.getAttribute("data-deep");
      if (act === "send" && s) { closeOverlay(true); CC.setTarget(s.name); CC.focusInput(); toast("Your next message goes to " + clip(s.name, 40) + " through JOYA AI."); }
      if (act === "interrupt") CC.interrupt(b);
      if (act === "rc") CC.openRemoteControl();
    }

    /* ======================================================== palette */

    function themeTo(t) { var b = document.querySelector('.topbar [data-theme-opt="' + t + '"]'); if (b) b.click(); }
    function palItems() {
      var it = [];
      function add(g, t, sub, icon, cls, run) { it.push({ g: g, t: t, sub: sub || "", icon: icon, cls: cls || "", run: run }); }
      add("Open", "Back to the core", "close the sheets", "orbit", "", function () { setView("map"); });
      add("Open", "Conversation", "the JOYA AI session", "message", "", function () { CC.openSheet("conv"); });
      add("Open", "Sessions", CC.liveSessions().length + " live · sub-agents · deep view", "orbit", "", function () { CC.openSheet("sessions"); });
      add("Open", "Missions board", "sheet", "flag", "m", function () { setView("missions"); });
      add("Open", "Decisions", decCount() + " need you", "inbox", "", function () { CC.openSheet("dec"); });
      add("Open", "The next decision card", decCount() + " need you", "shield", "", function () { CC.openNeed(); });
      add("Open", "Event log", "Decisions", "bolt", "", function () { CC.openSheet("dec"); var d = $("cc-evlog"); d.open = true; d.scrollIntoView({ block: "start" }); });
      add("Open", "Timeline", "delegations and approvals", "clock", "", function () { CC.openSheet("tl"); });
      add("Open", "Approval rules", "Rules & alerts", "scale", "", function () { P.rulesSub = "rules"; CC.openSheet("rules"); });
      add("Open", "System alerts", "Rules & alerts", "eye", "", function () { P.rulesSub = "watch"; CC.openSheet("rules"); });
      add("Open", "Schedules", P.orders.length + " standing orders · Rules & alerts", "repeat", "", function () { P.rulesSub = "orders"; CC.openSheet("rules"); });
      add("Open", "Usage", "Claude plan limits · tokens · voice", "gauge", "", function () { CC.openSheet("cost"); });
      add("Open", "Machine", "this VPS · the core grid", "server", "", function () { CC.openSheet("machine"); });
      add("Actions", "Usage details", "plan limits · tokens by session", "gauge", "", openCost);
      add("Actions", "New mission…", "JOYA AI plans it", "plus", "m", function () { openNewMission(); });
      add("Actions", "New standing order…", "scheduled prompt", "clock", "", function () { openOrder(null); });
      add("Actions", "Test a command in Rules…", "what would the gate do", "scale", "", function () {
        P.rulesSub = "rules"; CC.showPane("rules");
        var q = palQuery().replace(/^test\s*/i, "");
        var inp = $("cc-try-in");
        if (inp) { if (q && !/^test/i.test(q)) inp.value = P.tryText = ""; inp.focus(); }
      });
      if (S.status && S.status.busy) add("Actions", "Interrupt JOYA AI's current turn", "stops it", "stop", "", function () { CC.interrupt(); });
      missionList().forEach(function (m) {
        add("Missions", (m.ref || "M") + " · " + (m.title || m.goal || ""), m.status, "flag", "m", function () { P.activeMis = m.id; setView("missions"); renderMisChip(); });
      });
      CC.sortSessions(S.sessions).forEach(function (s) {
        var nm = s.self ? "JOYA AI" : s.name || "unnamed session";
        add("Sessions", "Deep view · " + nm, s.self ? "CEO" : CC.sessWhere(s), "eye", "", function () { openDeep(CC.sessKey(s)); });
        if (!s.self && s.name) add("Sessions", "Send to " + nm + " via JOYA AI…", "sets the composer", "send", "", function () { CC.setTarget(s.name); CC.focusInput(); });
      });
      P.orders.forEach(function (o) {
        add("Standing orders", "Edit " + o.name, o.label || "", "clock", "", function () { openOrder(o.id); });
        add("Standing orders", "Run " + o.name + " now", "result lands in the conversation", "play", "", function () {
          api("orders/" + encodeURIComponent(o.id) + "/run", { body: {} }).then(function (r) { if (r && r.order) upsertOrder(r.order); toast("Running " + o.name + " now."); }).catch(function (e) { toast("Not run: " + errText(e), true); });
        });
      });
      Object.keys(window.JoyaLogic.CORES).forEach(function (k) {
        add("Core", "JOYA AI core: " + k + " · " + window.JoyaLogic.CORES[k], k === CC.coreNow() ? "in use" : "switch now, saved for you", "spark", "", function () { CC.setCore(k); });
      });
      add("Theme", "Theme: follow the system", "", "monitor", "", function () { themeTo("system"); });
      add("Theme", "Theme: dark", "", "moon", "", function () { themeTo("dark"); });
      add("Theme", "Theme: light", "", "sun", "", function () { themeTo("light"); });
      return it;
    }
    function hl(s, idx) {
      var o = "", set = {};
      idx.forEach(function (i) { set[i] = 1; });
      for (var i = 0; i < s.length; i++) o += set[i] ? "<mark>" + esc(s.charAt(i)) + "</mark>" : esc(s.charAt(i));
      return o;
    }
    function palQuery() { var q = $("cc-pal-q"); return q ? q.value.trim() : ""; }
    function openPalette(q) {
      overlay("palette", '<div class="cc-pal-in">' + ic("search") + '<input id="cc-pal-q" placeholder="Search missions, sessions, orders, views, commands…" aria-label="Command palette" autocomplete="off" data-autofocus value="' + esc(q || "") + '"><kbd>Esc</kbd></div>' +
        '<ul class="cc-pal-list" id="cc-pal-list" role="listbox"></ul><div class="cc-pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span><span class="r">no match: Enter sends it to JOYA AI</span></div>',
        "cc-modal cc-pal", "Command palette");
      OV.pal = { list: [], sel: 0 };
      var inp = $("cc-pal-q");
      inp.addEventListener("input", palRender);
      inp.addEventListener("keydown", palKey);
      $("cc-pal-list").addEventListener("click", function (e) { var li = e.target.closest("[data-i]"); if (li) palRun(Number(li.getAttribute("data-i"))); });
      $("cc-pal-list").addEventListener("mousemove", function (e) { var li = e.target.closest("[data-i]"); if (li) palSel(Number(li.getAttribute("data-i"))); });
      palRender();
    }
    function palRender() {
      if (!OV.pal) return;
      var q = palQuery(), items = palItems(), out = [];
      if (!q) out = items.filter(function (x) { return x.g !== "Theme" && x.g !== "Standing orders" && x.g !== "Core"; }).slice(0, 18).map(function (x) { return { it: x, idx: [] }; });
      else {
        items.forEach(function (x) {
          var m = fuzzy(q, x.t), m2 = m || fuzzy(q, x.t + " " + x.sub + " " + x.g);
          if (m2) out.push({ it: x, idx: m ? m.idx : [], s: m2.score });
        });
        out.sort(function (a, b) { return b.s - a.s; });
        out = out.slice(0, 24);
      }
      var groups = [];
      out.forEach(function (o) { if (groups.indexOf(o.it.g) < 0) groups.push(o.it.g); });
      var ordered = [];
      groups.forEach(function (gr) { out.forEach(function (o) { if (o.it.g === gr) ordered.push(o); }); });
      OV.pal.list = ordered;
      OV.pal.sel = 0;
      var g = null, h = "";
      ordered.forEach(function (o, i) {
        if (o.it.g !== g) { g = o.it.g; h += '<li class="cc-pal-g" role="presentation">' + esc(g) + "</li>"; }
        h += '<li class="cc-pal-it' + (i === 0 ? " on" : "") + '" role="option" data-i="' + i + '" aria-selected="' + (i === 0) + '"><span class="pi ' + o.it.cls + '">' + ic(o.it.icon) + '</span><span class="pt">' + hl(o.it.t, o.idx) + (o.it.sub ? "<small>" + esc(o.it.sub) + "</small>" : "") + '</span><span class="pk"></span></li>';
      });
      $("cc-pal-list").innerHTML = h || '<li class="cc-pal-g">No match. Enter sends “' + esc(clip(q, 60)) + "” to JOYA AI.</li>";
    }
    function palSel(i) {
      if (!OV.pal) return;
      OV.pal.sel = i;
      var lis = document.querySelectorAll(".cc-pal-it");
      for (var k = 0; k < lis.length; k++) {
        var on = Number(lis[k].getAttribute("data-i")) === i;
        lis[k].classList.toggle("on", on);
        lis[k].setAttribute("aria-selected", String(on));
      }
      var el = document.querySelector(".cc-pal-it.on");
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function palKey(e) {
      var n = OV.pal ? OV.pal.list.length : 0;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) palSel((OV.pal.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (n) palRun(OV.pal.sel);
        else { var v = palQuery(); closeOverlay(); if (v) CC.send(v); }
      }
    }
    function palRun(i) {
      var o = OV.pal && OV.pal.list[i];
      var q = palQuery();
      if (!o) return;
      closeOverlay(true);
      OV.lastQuery = q;
      o.it.run();
    }

    /* ======================================================== loading + events */

    /** The mission a session is working for right now, from the board. */
    function missionFor(name) {
      var out = null;
      P.missions.forEach(function (m) {
        if (out || m.status !== "active") return;
        (m.steps || []).forEach(function (s) {
          if (!out && s.target === name && s.status !== "done" && s.status !== "skipped" && s.status !== "failed" && s.status !== "planned") {
            out = { id: m.id, ref: m.ref, step_n: s.n, step_status: s.status, derived: true };
          }
        });
      });
      return out;
    }
    function load(ov) {
      // The overview already carries the open lists: draw them at once, then read the full ones.
      if (ov) {
        if (Array.isArray(ov.missions)) ov.missions.forEach(function (m) { P.missions.set(m.id, m); });
        if (Array.isArray(ov.decisions)) ov.decisions.forEach(function (d) { P.decisions.set(d.id, d); });
        if (Array.isArray(ov.watchers)) P.watchers = ov.watchers;
        if (Array.isArray(ov.orders)) { P.orders = ov.orders; if (ov.orders_tz) P.ordersTz = ov.orders_tz; if (ov.telegram) P.telegram = ov.telegram; }
        renderAll();
      }
      api("missions?status=all").then(function (r) { P.missions.clear(); (r.missions || []).forEach(function (m) { P.missions.set(m.id, m); }); delete P.err.missions; })
        .catch(function (e) { P.err.missions = errText(e); }).then(function () { renderMisChip(); if (S.pane === "missions") renderMissions(); CC.resyncSessions(); });
      api("decisions?status=all").then(function (r) { P.decisions.clear(); (r.decisions || []).forEach(function (d) { P.decisions.set(d.id, d); }); delete P.err.decisions; })
        .catch(function (e) { P.err.decisions = errText(e); }).then(function () { renderDecisions(); });
      api("watchers").then(function (r) { P.watchers = r.watchers || []; delete P.err.watchers; }).catch(function (e) { P.err.watchers = errText(e); }).then(function () { renderRules(); });
      api("rules").then(function (r) { P.rules = r.rules || []; delete P.err.rules; }).catch(function (e) { P.err.rules = errText(e); }).then(function () { renderRules(); });
      api("orders").then(function (r) {
        P.orders = r.orders || [];
        if (r.tz) P.ordersTz = r.tz;
        P.telegram = r.telegram || null;
        delete P.err.orders;
      }).catch(function (e) { P.err.orders = errText(e); }).then(function () { renderOrders(); });
      loadCost();
    }
    setInterval(function () { if (!document.hidden && S.online) loadCost(); }, 60000);

    function onEvent(type, ev, replay) {
      switch (type) {
        case "mission": upsertMission(ev.mission, replay); return;
        case "decision": upsertDecision(ev.decision, replay); CC.paintState(); return;
        case "watcher": upsertWatcher(ev.watcher); return;
        case "order":
          if (ev.deleted != null) { P.orders = P.orders.filter(function (o) { return String(o.id) !== String(ev.deleted); }); renderOrders(); }
          else upsertOrder(ev.order);
          return;
        case "order_run":
          if (ev.order) upsertOrder(ev.order);
          if (ev.run && OV.ed && ev.order && String(OV.ed.id) === String(ev.order.id) && Array.isArray(OV.ed.runs)) {
            var i = OV.ed.runs.findIndex(function (r) { return r.id === ev.run.id; });
            if (i >= 0) OV.ed.runs[i] = ev.run; else OV.ed.runs.unshift(ev.run);
            renderOrderSide();
          }
          if (!replay && ev.run && ev.run.status !== "running") CC.feedPush({ key: "run" + ev.run.id + ev.run.status, ts: ev.run.ended_at || ev.ts, kind: ev.run.status === "ok" ? "done" : "error", label: "order", html: "<b>" + esc((ev.order && ev.order.name) || "Standing order") + "</b> · " + esc(ev.run.status) });
          return;
        case "rule":
          if (ev.deleted != null) { P.rules = P.rules.filter(function (r) { return String(r.id) !== String(ev.deleted); }); renderRules(); }
          else upsertRule(ev.rule, true);
          return;
      }
    }

    function renderAll() {
      renderMisChip();
      renderCostWidget();
      renderVoiceUsage();
      renderOrders();
      renderDecisions();
      if (S.pane === "rules") renderRules();
      if (S.pane === "missions") renderMissions();
    }

    return {
      load: load,
      onEvent: onEvent,
      renderAll: renderAll,
      renderDecisions: renderDecisions,
      renderRules: function () { P.rulesPending = "now"; renderRules(); },
      /** Which tab the Rules & alerts sheet opens on: rules | watch | orders (the old Standing orders sheet). */
      setRulesSub: function (sub) { if (sub === "rules" || sub === "watch" || sub === "orders") P.rulesSub = sub; },
      sessionsChanged: function () {
        if (S.pane === "missions") renderMissions();
        if (OV.kind === "deep") renderDeep();
      },
      openDeep: openDeep,
      renderMissions: renderMissions,
      upsertDecision: upsertDecision,
      decisionsList: function () { var out = []; P.decisions.forEach(function (d) { out.push(d); }); return out; },
      voiceToday: function () { var u = P.voiceUsage; return u && u.today ? vmoney(u.today.total) + " today" : ""; },
      openAlways: openAlways,
      openOrder: openOrder,
      openCost: openCost,
      setVoiceUsage: setVoiceUsage,
      loadVoiceUsage: loadVoiceUsage,
      openPalette: openPalette,
      openNewMission: openNewMission,
      setView: setView,
      orderById: orderById,
      missionFor: missionFor,
      whenText: whenText,
      state: P,
    };
  };
})();
