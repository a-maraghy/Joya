"use strict";
/*
 * Proactive JOYA AI, the page's half (the Command Center and the desktop app's render mode,
 * ?shell=desktop): the morning brief and "while you were away" as a card, watcher alerts in the
 * Live feed, a toast, and -- in the desktop app -- a Windows toast and the glance cards. The
 * server writes everything (lib/routes-proactive.js); this file fetches it, shows it, and says
 * when the person is active.
 *
 *   - On load: GET /joya-ai/api/proactive (the inbox: today's watcher alerts, the newest brief and
 *     catch-up not dismissed). Then every 15 s, the newer rows only.
 *   - Activity (a key, a click, the tab coming back): POST /joya-ai/api/proactive/seen, at most
 *     once a minute; the answer may carry a catch-up.
 *   - The composer: "tell me when ...", "alert me if ...", "watch for ...", "remind me at ..." is
 *     offered as a watcher first (Set watcher / Send to JOYA AI instead).
 *   - The live call: with "read it aloud" on and a brief not read yet, the brief is read first.
 *   - The desktop app: a new brief or watcher alert asks the app for its toast (needs_you, with a
 *     negative id so its second button only dismisses; the app shows it only when JOYA AI cannot be
 *     seen) and redraws the glance cards (joya-desktop.js asks JoyaProactive.current()).
 *
 * Every string from the server is put on the page as text (esc / textContent).
 */
(function () {
  var cc = document.getElementById("cc");
  if (!cc) return;
  var DESK = cc.getAttribute("data-shell") === "desktop";
  var CSRF = cc.getAttribute("data-csrf") || "";
  var T = window.__TAURI__ || null;
  var POLL_MS = 15000, SEEN_MS = 60000, TOAST_BASE = 1000000;
  var TRIGGER = /^(?:(?:please|hey|ok|okay)[, ]+)?(?:joya ai[, ]+)?(?:can you |could you |would you )?(?:(?:tell|let|ping|notify|alert|warn|message|remind)\s+me\b|let me know\b|watch\b|keep an eye\b|i want to know\b|i'd like to know\b)/i;
  var P = { prefs: null, lastId: 0, cards: {}, shownCard: null, dismissed: {}, toasted: {}, seenAt: 0, readIds: {}, loaded: false };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function api(path, body) {
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.headers["X-CSRF-Token"] = CSRF; init.body = JSON.stringify(body); }
    return fetch("/joya-ai/api/proactive" + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || "HTTP " + r.status); e.status = r.status; throw e; } return j; });
    });
  }
  function invoke(cmd, args) { if (!T || !T.core) return null; try { return T.core.invoke(cmd, args || {}); } catch (e) { return null; } }
  function hm(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: P.prefs && P.prefs.tz ? P.prefs.tz : undefined }).format(d); } catch (e) { return d.toTimeString().slice(0, 5); }
  }
  function changed() { try { document.dispatchEvent(new CustomEvent("joya-proactive")); } catch (e) { /* old engine */ } }
  function mcc() { return window.__joyaCC || null; }
  var SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function sound(name) { if (window.JoyaSound && window.JoyaSound.play) window.JoyaSound.play(name, { role: "core" }); }
  function story(sid, t) { return !!(sid && window.JoyaStory && window.JoyaStory.open && window.JoyaStory.open(sid, t || null)); }

  /* ---------------------------------------------------------------- the inbox */
  function take(items, quiet) {
    (items || []).forEach(function (it) {
      if (!it || !it.id) return;
      if (it.id > P.lastId) P.lastId = it.id;
      if (it.kind === "watch") return watchItem(it, quiet);
      if (it.kind === "brief" || it.kind === "catchup") return cardItem(it, quiet);
    });
    render();
  }
  function watchItem(it, quiet) {
    var c = mcc(), b = it.body || {};
    var text = b.text || it.title;
    if (c && c.feed) c.feed({ key: "pa" + it.id, ts: it.created_at, kind: "watch", label: "watcher", html: "<b>Watcher</b> · " + esc(text) }, quiet);
    if (quiet) return;
    sound("needs");
    if (DESK) nativeToast(it.id, "JOYA AI · watcher", text + (b.watcher ? " (" + b.watcher + ")" : ""));
    else pageToast(text, b.watcher || "", SID_RE.test(String(b.session || "")) ? { sid: b.session, t: it.created_at } : null);
  }
  function cardItem(it, quiet) {
    if (it.dismissed_at || P.dismissed[it.id]) return;
    var b = it.body || {};
    var cur = P.cards[it.kind];
    if (cur && cur.id > it.id) return;
    P.cards[it.kind] = { id: it.id, kind: it.kind, title: it.title, lines: (b.lines || []).map(function (l) { return { k: String(l.k || ""), text: String(l.text || ""), tone: /^(ok|warn|err|info)$/.test(l.tone) ? l.tone : "info", sid: SID_RE.test(String(l.sid || "")) ? l.sid : null }; }), source: b.source || "template", why: b.why || "", speech: b.speech || "", at: hm(it.created_at), created_at: it.created_at, from: b.from || null };
    var c = mcc();
    if (c && c.feed) c.feed({ key: "pa" + it.id, ts: it.created_at, kind: "brief", label: it.kind === "catchup" ? "catch-up" : "brief", html: "<b>" + esc(it.kind === "catchup" ? "While you were away" : "Morning brief") + "</b> · " + esc(firstLine(P.cards[it.kind])) }, quiet);
    if (!quiet) sound("wake");
    if (!quiet && DESK) nativeToast(it.id, it.kind === "catchup" ? "While you were away" : "JOYA AI · morning brief", firstLine(P.cards[it.kind]));
  }
  function firstLine(card) {
    var l = card.lines[0];
    return l ? (l.k === "Quiet" ? l.text : l.k + ": " + l.text) : card.title;
  }
  /** The card to show: the newest of the brief and the catch-up. */
  function current() {
    var a = P.cards.brief, b = P.cards.catchup;
    if (a && b) return a.id > b.id ? a : b;
    return a || b || null;
  }
  function dismiss(id) {
    P.dismissed[id] = 1;
    ["brief", "catchup"].forEach(function (k) { if (P.cards[k] && P.cards[k].id === id) delete P.cards[k]; });
    render();
    return api("/inbox/" + Number(id) + "/dismiss", {}).catch(function () { /* dismissed here; the server forgets nothing worse */ });
  }

  /* ---------------------------------------------------------------- the card (the browser Command Center) */
  function render() {
    changed();
    if (DESK) return; // the desktop app shows it as a glance card (joya-desktop.js)
    var card = current();
    var el = $("pa-card");
    if (!card) { if (el) el.remove(); P.shownCard = null; return; }
    var sig = card.id + "|" + card.lines.length;
    if (el && P.shownCard === sig) return;
    P.shownCard = sig;
    if (!el) {
      el = document.createElement("section");
      el.id = "pa-card";
      el.className = "pa-card";
      el.setAttribute("role", "region");
      cc.appendChild(el);
      el.addEventListener("click", onCard);
    }
    el.setAttribute("aria-label", card.kind === "catchup" ? "While you were away" : "Morning brief");
    el.classList.toggle("catchup", card.kind === "catchup");
    var can = !!(mcc() && cc.getAttribute("data-voice-ready") === "1");
    el.innerHTML =
      '<header><span class="pa-ic" aria-hidden="true">' + (card.kind === "catchup" ? "↩" : "☀") + '</span><div class="pa-h"><b>' + esc(card.title.split(" · ")[0]) + "</b><small>" + esc(card.title.split(" · ").slice(1).join(" · ") || "") + (card.at ? " · " + esc(card.at) : "") + "</small></div>" +
      '<button type="button" class="pa-x" data-pa="dismiss" aria-label="Dismiss">×</button></header>' +
      '<ul class="pa-lines">' + card.lines.map(function (l) { var lab = l.sid && window.JoyaStory ? '<button type="button" class="pa-st" data-pa="story" data-sid="' + esc(l.sid) + '" title="Open the story of ' + esc(l.k) + '">' + esc(l.k) + "</button>" : esc(l.k); return '<li class="t-' + l.tone + '"><i aria-hidden="true"></i><b>' + lab + "</b><span>" + esc(l.text) + "</span></li>"; }).join("") + "</ul>" +
      '<footer><small title="' + esc(card.source === "model" ? "Worded by JOYA AI's summary model; every number checked against the data." : card.why ? "From the data (" + card.why + ")." : "From the data.") + '">' + (card.source === "model" ? "Checked against the data" : "From the data") + "</small><span class=\"sp\"></span>" +
      (can && card.speech ? '<button type="button" class="pa-b" data-pa="read">Read aloud</button>' : "") +
      '<a class="pa-b" href="/joya-ai/settings/proactive">Settings</a><button type="button" class="pa-b pri" data-pa="dismiss">Dismiss</button></footer>';
  }
  function onCard(e) {
    var b = e.target.closest ? e.target.closest("[data-pa]") : null;
    if (!b) return;
    var card = current();
    if (!card) return;
    var a = b.getAttribute("data-pa");
    if (a === "dismiss") dismiss(card.id);
    if (a === "read") readAloud(card);
    if (a === "story") story(b.getAttribute("data-sid"), card.from);
  }
  function readAloud(card) {
    var c = mcc();
    if (!c || !c.say || !card.speech) return false;
    P.readIds[card.id] = 1;
    return c.say(card.speech);
  }

  /* ---------------------------------------------------------------- toasts */
  function pageToast(text, sub, link) {
    if (window.JoyaPresenceHold && window.JoyaPresenceHold.toast(text + (sub ? ": " + sub : ""))) return; // eye contact: you are away
    var box = $("pa-toasts");
    if (!box) { box = document.createElement("div"); box.id = "pa-toasts"; box.className = "pa-toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    var t = document.createElement("div");
    t.className = "pa-toast";
    t.setAttribute("role", "status");
    t.innerHTML = '<i aria-hidden="true"></i><div><b>Watcher</b><span></span>' + (sub ? "<small></small>" : "") + '</div><button type="button" aria-label="Close">×</button>';
    t.querySelector("span").textContent = text;
    if (sub) t.querySelector("small").textContent = sub;
    t.querySelector("button").addEventListener("click", function () { t.remove(); });
    if (link && window.JoyaStory) {
      var st = document.createElement("button");
      st.type = "button"; st.className = "pa-b"; st.textContent = "Story";
      st.setAttribute("aria-label", "Open the session's story");
      st.addEventListener("click", function () { if (story(link.sid, link.t)) t.remove(); });
      t.querySelector("div").appendChild(st);
    }
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 400); }, 9000);
  }
  /** The app's Windows toast (shown only when JOYA AI cannot be seen; the app decides). */
  function nativeToast(id, title, body) {
    if (!T || P.toasted[id]) return;
    P.toasted[id] = 1;
    if (window.JoyaPresenceHold && window.JoyaPresenceHold.native({ title: title, body: body })) return; // eye contact: you are away
    invoke("needs_you", { id: -(TOAST_BASE + Number(id)), title: String(title).slice(0, 120), body: String(body).slice(0, 280) });
  }

  /* ---------------------------------------------------------------- loading and polling */
  function load() {
    return api("").then(function (j) {
      P.prefs = j.prefs || null;
      P.loaded = true;
      // What was there before the page opened is history: in the log, no toast.
      take(j.inbox, true);
    }).catch(function () { /* JOYA AI's page shows its own offline state */ });
  }
  var polls = 0;
  function poll() {
    if (!P.loaded) return load();
    // Every fourth time, the whole inbox: a card dismissed on another device goes here too.
    if (++polls % 4 === 0) {
      return api("").then(function (j) {
        P.prefs = j.prefs || P.prefs;
        var live = {};
        (j.inbox || []).forEach(function (it) { live[it.id] = 1; });
        ["brief", "catchup"].forEach(function (k) { if (P.cards[k] && !live[P.cards[k].id]) delete P.cards[k]; });
        take((j.inbox || []).filter(function (it) { return it.id > P.lastId; }), false);
      }).catch(function () { /* next time */ });
    }
    return api("/inbox?after=" + P.lastId).then(function (j) { take(j.items, false); }).catch(function () { /* next time */ });
  }
  setInterval(function () { if (!document.hidden || DESK) poll(); }, POLL_MS);

  /* ---------------------------------------------------------------- activity: "while you were away" */
  function active() {
    var now = Date.now();
    if (now - P.seenAt < SEEN_MS) return;
    P.seenAt = now;
    api("/seen", {}).then(function (j) { if (j && j.catchup) take([j.catchup], false); }).catch(function () { /* next time */ });
  }
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (n) { window.addEventListener(n, active, { passive: true, capture: true }); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { active(); poll(); } });
  window.addEventListener("focus", active);

  /* ---------------------------------------------------------------- the composer: a watcher first */
  function intercept(text) {
    text = String(text || "").trim();
    if (!TRIGGER.test(text) || text.length > 300) return false;
    api("/parse", { text: text }).then(function (r) {
      if (!r || !r.ok) return sendOn(text);
      offer(text, r);
    }, function () { sendOn(text); });
    return true;
  }
  function sendOn(text) {
    var c = mcc();
    if (c && c.send) c.send(text);
  }
  function offer(text, r) {
    var old = $("pa-offer");
    if (old) old.remove();
    var dock = $("cc-dock") || cc;
    var el = document.createElement("div");
    el.id = "pa-offer";
    el.className = "pa-offer";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Set a watcher");
    el.innerHTML = '<div class="pa-o-t"><b>Set a watcher?</b><span></span><small></small></div>' +
      '<div class="pa-o-a"><button type="button" class="pa-b pri" data-o="set">Set watcher</button><button type="button" class="pa-b" data-o="send">Send to JOYA AI instead</button><button type="button" class="pa-x" data-o="close" aria-label="Close">×</button></div>';
    el.querySelector("span").textContent = r.text;
    el.querySelector("small").textContent = (r.note ? r.note + " " : "") + "It only notifies you: in the Live feed, as a toast, and on the desktop. " + (r.count >= r.max ? "You have " + r.max + " watchers, the most there can be." : r.count + " of " + r.max + " watchers set.");
    dock.insertBefore(el, dock.firstChild);
    var setB = el.querySelector('[data-o="set"]');
    if (r.count >= r.max) setB.disabled = true;
    setB.focus();
    el.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-o]") : null;
      if (!b) return;
      var o = b.getAttribute("data-o");
      if (o === "close") { el.remove(); return; }
      if (o === "send") { el.remove(); sendOn(text); return; }
      if (o === "set") {
        b.disabled = true;
        api("/watchers", { spec: r.spec }).then(function (j) {
          el.classList.add("done");
          el.querySelector(".pa-o-t").innerHTML = "<b>Watching</b><span></span><small>Pause or delete it in Settings ▸ Briefs &amp; watchers.</small>";
          el.querySelector(".pa-o-t span").textContent = j.watcher.text;
          el.querySelector(".pa-o-a").innerHTML = '<a class="pa-b" href="/joya-ai/settings/proactive#pa-watchers">Watchers</a><button type="button" class="pa-x" data-o="close" aria-label="Close">×</button>';
          var inp = $("cc-input");
          if (inp) inp.value = "";
          setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
        }, function (e) {
          b.disabled = false;
          el.querySelector(".pa-o-t small").textContent = "Not set: " + e.message;
        });
      }
    });
    el.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); el.remove(); var i = $("cc-input"); if (i) i.focus(); } });
  }

  /* ---------------------------------------------------------------- the live call: the brief first */
  var reading = null;
  function beforeLive(go) {
    var c = mcc(), card = P.cards.brief;
    if (reading) { // asked again while reading: stop and start the call now
      clearInterval(reading);
      reading = null;
      if (c && c.stopSpeaking) c.stopSpeaking();
      return false;
    }
    if (!P.prefs || !P.prefs.read_aloud || !card || P.readIds[card.id] || !card.speech || !c || !c.say) return false;
    if (!readAloud(card)) return false;
    var t0 = Date.now(), began = false;
    reading = setInterval(function () {
      var sp = c.speaking();
      if (sp) began = true;
      if ((began && !sp) || Date.now() - t0 > (began ? 90000 : 8000)) {
        clearInterval(reading);
        reading = null;
        go();
      }
    }, 300);
    return true;
  }

  window.JoyaProactive = {
    current: current,
    dismiss: dismiss,
    intercept: intercept,
    beforeLive: beforeLive,
    toastDeny: function (nid) { var id = -Number(nid) - TOAST_BASE; if (P.cards.brief && P.cards.brief.id === id || P.cards.catchup && P.cards.catchup.id === id) dismiss(id); },
    looksLikeWatcher: function (t) { return TRIGGER.test(String(t || "").trim()); },
    state: P,
    poll: poll,
    active: function () { P.seenAt = 0; active(); },
  };
  load().then(function () { active(); });
})();
