"use strict";
/*
 * Joya > Computers (lib/views-machines.js): keeps the online pills, the
 * lease's time left and the Chrome state current, and grows each take-over's
 * action log live while it runs (GET /machines/api/lease/:lid?after=<id>).
 * Read-only: every change is one of the page's forms. New rows are built with
 * the DOM (textContent), never from HTML strings.
 */
(function () {
  const list = document.getElementById("mc-list");
  const acts = document.getElementById("mc-acts");

  function left(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return "now";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return "in " + m + ":" + String(s).padStart(2, "0");
  }
  function tick() {
    document.querySelectorAll("[data-lease][data-expires]").forEach((el) => {
      const out = el.querySelector("[data-left]");
      if (out) out.textContent = left(el.getAttribute("data-expires"));
    });
  }

  /* ------------------------------------------------------------ the live action log */

  // Same as lib/views-machines.js actionRow (keep in step).
  const KIND = { hands: "Files", browser: "Chrome", cli: "Command" };
  const DECISION = { auto: ["neutral", "by the rules"], approved: ["ok", "you approved"], denied: ["bad", "not approved"], refused: ["bad", "refused"] };
  function toolName(t) {
    const s = String(t || "");
    const short = s.indexOf("mcp__") === 0 ? s.split("__").slice(2).join("__") || s : s;
    return short.replace(/_mcp$/, "").replace(/_/g, " ");
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function kindIcon(kind) {
    const t = document.getElementById("mc-kind-icons");
    const src = t && t.content && t.content.querySelector('[data-kind-icon="' + (KIND[kind] ? kind : "cli") + '"] svg');
    return src ? src.cloneNode(true) : null;
  }
  function row(a) {
    const ok = a.result === "ok";
    const li = el("li", "mc-log-row" + (ok ? "" : " failed"));
    li.setAttribute("data-lid", String(a.id));
    li.appendChild(el("span", "mc-log-time mono small", String(a.at || "").slice(11, 19)));
    const kind = el("span", "mc-log-kind small");
    kind.title = KIND[a.kind] || KIND.cli;
    const ic = kindIcon(a.kind);
    if (ic) kind.appendChild(ic);
    kind.appendChild(el("span", null, KIND[a.kind] || KIND.cli));
    li.appendChild(kind);
    const what = el("span", "mc-log-what");
    what.appendChild(el("b", null, toolName(a.tool)));
    what.appendChild(document.createTextNode(" "));
    what.appendChild(el("span", "mc-log-target", a.target || ""));
    if (a.detail) what.appendChild(el("span", "mc-log-detail muted small", a.detail));
    li.appendChild(what);
    const pills = el("span", "mc-log-pills");
    pills.appendChild(el("span", "pill " + (ok ? "ok" : "warn") + " nodot", ok ? "done" : "failed"));
    pills.appendChild(document.createTextNode(" "));
    const d = DECISION[a.decision] || DECISION.auto;
    pills.appendChild(el("span", "pill " + d[0] + " nodot", d[1]));
    li.appendChild(pills);
    return li;
  }

  const ended = new Set();
  async function refreshLogs() {
    const logs = document.querySelectorAll("[data-live-log]");
    for (const ol of logs) {
      if (ol.getAttribute("data-active") === "0") continue;
      const lid = ol.getAttribute("data-live-log");
      const after = Number(ol.getAttribute("data-after")) || 0;
      try {
        const r = await fetch("/machines/api/lease/" + encodeURIComponent(lid) + "?after=" + after, { headers: { accept: "application/json" }, credentials: "same-origin" });
        if (!r.ok) continue;
        const j = await r.json();
        const fresh = (j.log || []).filter((a) => a.id > after);
        if (fresh.length) {
          const empty = ol.querySelector(".mc-log-empty");
          if (empty) empty.remove();
          for (const a of fresh) {
            const li = row(a);
            li.classList.add("new");
            ol.appendChild(li);
          }
          ol.setAttribute("data-after", String(fresh[fresh.length - 1].id));
          const keep = Number(ol.getAttribute("data-keep")) || 0;
          if (keep) while (ol.querySelectorAll(".mc-log-row").length > keep) ol.querySelector(".mc-log-row").remove();
        }
        if (j.lease && j.lease.ended_at && !ended.has(lid)) {
          ended.add(lid);
          ol.setAttribute("data-active", "0");
          // The full log page: say it ended; the list page reloads with the computer's new state.
          if (!list) location.reload();
        }
      } catch (_) {
        /* offline for a moment */
      }
    }
  }

  /* ------------------------------------------------------------ the list */

  function chromeSig(c) {
    if (!c) return "none";
    return (c.extension ? 1 : 0) + "" + (c.allowed === false ? 0 : 1) + (c.last ? (c.last.connected ? 1 : 0) : "-");
  }

  async function refreshList() {
    try {
      const r = await fetch("/machines/api/list", { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json();
      let changed = false;
      for (const m of j.machines || []) {
        const pill = document.querySelector('[data-online="' + m.id + '"]');
        if (pill) {
          const want = m.online ? "online" : "offline";
          if (pill.textContent !== want) {
            pill.textContent = want;
            pill.classList.toggle("ok", !!m.online);
            pill.classList.toggle("neutral", !m.online);
            changed = true;
          }
        }
        const row = document.querySelector('[data-mid="' + m.id + '"]');
        const shown = row && row.querySelector("[data-lease]");
        const had = shown ? Number(shown.getAttribute("data-lease")) : null;
        const now = m.lease ? m.lease.id : null;
        if (had !== now) changed = true;
        if (shown && m.lease) shown.setAttribute("data-expires", m.lease.expires_at);
        // Claude Code installed (or gone) since the page was drawn: "Look again" in the app.
        const cl = row && row.querySelector("[data-claude]");
        const wasFound = cl ? cl.getAttribute("data-found") === "1" : null;
        const isFound = m.claude ? !!m.claude.found : null;
        if (row && wasFound !== isFound) changed = true;
        // The Chrome extension set up, connected or gone.
        const ch = row && row.querySelector("[data-chrome-sig]");
        if (ch && ch.getAttribute("data-chrome-sig") !== chromeSig(m.chrome)) changed = true;
      }
      // A lease started or ended elsewhere: the forms change too, so the page is reloaded (not while typing).
      if (changed && !document.activeElement.matches("textarea, input")) location.reload();
    } catch (_) {
      /* offline for a moment */
    }
  }

  tick();
  setInterval(tick, 1000);
  if (list) setInterval(refreshList, 5000);
  if (document.querySelector("[data-live-log]")) setInterval(refreshLogs, 2500);
  void acts;
})();
