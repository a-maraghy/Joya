"use strict";
/**
 * Joya > Computers (lib/machines.js): the user's own computers linked
 * through the JOYA AI desktop app -- pair, rename, revoke, online state, let
 * JOYA AI take over (a lease), extend or stop it, whether its Chrome can be
 * used (the user's Claude in Chrome extension) with the steps to set it up,
 * the folders JOYA AI may use there, and the action log of every take-over,
 * live while it runs. Everything escaped; no inline script or style
 * (public/machines.js, public/machines.css).
 */

const { esc, shell, card, icon, ago, empty } = require("./ui");

const when = (s) => (s ? esc(String(s).slice(0, 16).replace("T", " ")) + " UTC" : "");
const hms = (s) => (s ? esc(String(s).slice(11, 19)) : "");

function onlinePill(m) {
  return `<span class="pill ${m.online ? "ok" : "neutral"}" data-online="${m.id}">${m.online ? "online" : "offline"}</span>`;
}

/* ------------------------------------------------------------ the action log */

const KIND = { hands: ["file", "Files"], browser: ["network", "Chrome"], cli: ["cpu", "Command"] };
const DECISION = { auto: ["neutral", "by the rules"], approved: ["ok", "you approved"], denied: ["bad", "not approved"], refused: ["bad", "refused"] };

/** "mcp__joya-hands__office_edit" -> "office edit", "mcp__claude-in-chrome__navigate" -> "navigate", "PowerShell". */
function toolName(t) {
  const s = String(t || "");
  const short = s.startsWith("mcp__") ? s.split("__").slice(2).join("__") || s : s;
  return short.replace(/_mcp$/, "").replace(/_/g, " ");
}

/** One row of a take-over's action log (also built by public/machines.js for the live log: keep in step). */
function actionRow(a) {
  const [ic, kind] = KIND[a.kind] || KIND.cli;
  const [dc, dt] = DECISION[a.decision] || DECISION.auto;
  const ok = a.result === "ok";
  return `<li class="mc-log-row${ok ? "" : " failed"}" data-lid="${esc(String(a.id))}">
      <span class="mc-log-time mono small">${hms(a.at)}</span>
      <span class="mc-log-kind small" title="${esc(kind)}">${icon(ic, 14)}<span>${esc(kind)}</span></span>
      <span class="mc-log-what"><b>${esc(toolName(a.tool))}</b> <span class="mc-log-target">${esc(a.target || "")}</span>${a.detail ? `<span class="mc-log-detail muted small">${esc(a.detail)}</span>` : ""}</span>
      <span class="mc-log-pills"><span class="pill ${ok ? "ok" : "warn"} nodot">${ok ? "done" : "failed"}</span> <span class="pill ${dc} nodot">${esc(dt)}</span></span>
    </li>`;
}

/** The kinds' icons for the live log's new rows (public/machines.js clones them; no inline script). */
function kindIcons() {
  return `<template id="mc-kind-icons">${Object.entries(KIND).map(([k, [ic]]) => `<span data-kind-icon="${k}">${icon(ic, 14)}</span>`).join("")}</template>`;
}

function liveLog(m) {
  const l = m.lease;
  if (!l) return "";
  const rows = (m.recent || []).map(actionRow).join("");
  const last = (m.recent || []).length ? m.recent[m.recent.length - 1].id : 0;
  return `<div class="mc-live">
      <div class="mc-live-head small"><span class="mc-live-dot" aria-hidden="true"></span><b>Live action log</b> <span class="muted">· every file, browser and command step, as it happens</span></div>
      <ol class="mc-log" data-live-log="${l.id}" data-after="${esc(String(last))}" data-keep="8">${rows || `<li class="mc-log-empty muted small">No actions yet.</li>`}</ol>
    </div>`;
}

/* ------------------------------------------------------------ one computer */

function leaseBlock(m, csrf) {
  const l = m.lease;
  if (!l) return "";
  return `<div class="mc-lease" data-lease="${l.id}" data-expires="${esc(l.expires_at)}">
      <div class="mc-lease-head">${icon("core", 16)}<b>JOYA AI is in control</b> <span class="muted small">since ${when(l.started_at)}, by ${esc(l.started_by === "joya-ai" ? "JOYA AI" : l.started_by || "?")}</span></div>
      <p class="small">${esc(l.purpose || "")}</p>
      <p class="small">Ends <span class="mono" data-left="${l.id}">${when(l.expires_at)}</span>. On the computer: Ctrl+Alt+Esc stops it at once.</p>
      ${liveLog(m)}
      <div class="btn-row">
        <form method="post" action="/machines/${m.id}/extend"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn" type="submit">${icon("plus", 14)} 15 minutes</button></form>
        <form method="post" action="/machines/${m.id}/stop"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn danger" type="submit">${icon("stop", 14)} Stop now</button></form>
        <a class="btn ghost" href="/machines/${m.id}/lease/${l.id}">Full log</a>
      </div>
    </div>`;
}

/** Claude Code as the computer reported it: "found (version)", "not found", or nothing when unknown. */
function claudeStatus(m) {
  const c = m.claude;
  if (!c) return "";
  if (c.found) return `<span data-claude="${m.id}" data-found="1">Claude Code ${esc(c.version || "found")}</span>`;
  return `<span class="warn-text" data-claude="${m.id}" data-found="0">Claude Code: not found</span>`;
}

function claudeMissingNote(m) {
  return `<div class="alert warn" data-claude-missing="${m.id}">${icon("alert")}<div><b>Claude Code: not found</b> on this computer, so JOYA AI cannot take it over yet. Install Claude Code there and sign in once by running <span class="mono">claude</span> in a terminal, then press <b>Look again</b> in the JOYA AI app (Settings &#9656; This computer).</div></div>`;
}

/**
 * The Chrome connection: { state, text } where state is connected | set-up | not-connected | missing | off | unknown.
 * "connected" means the extension answered in the latest take-over that used the browser.
 */
function chromeState(m) {
  const c = m.chrome;
  if (!c) return { state: "unknown", text: "Chrome: not reported yet (the JOYA AI app on that computer is older than 0.1.11, or has not linked since)" };
  if (c.allowed === false) return { state: "off", text: "Chrome: switched off for JOYA AI on this computer" };
  if (!c.extension) return { state: "missing", text: "Chrome: the Claude in Chrome extension is not set up on this computer" };
  const where = c.browser ? ` in ${esc(c.browser)}${c.profile ? ` (${esc(c.profile)})` : ""}` : "";
  if (c.last && c.last.connected) return { state: "connected", text: `Chrome: connected${where} · it answered ${c.last.at ? esc(ago(c.last.at)) : "in the last take-over"}` };
  if (c.last && !c.last.connected) return { state: "not-connected", text: `Chrome: the extension${where} did not answer in the last take-over${c.last.detail ? ` (${esc(c.last.detail)})` : ""}` };
  return { state: "set-up", text: `Chrome: Claude in Chrome is installed${where}; not used by JOYA AI yet` };
}

/** What public/machines.js compares to reload when the Chrome state changed (the same rule there). */
function chromeSig(c) {
  if (!c) return "none";
  return `${c.extension ? 1 : 0}${c.allowed === false ? 0 : 1}${c.last ? (c.last.connected ? 1 : 0) : "-"}`;
}

const SETUP_STEPS = `<ol class="steps small">
    <li>On that computer, open <b>Google Chrome</b> and install <b>Claude in Chrome</b> from <span class="mono">claude.ai/chrome</span> (the Chrome Web Store).</li>
    <li>Sign in to the extension with the <b>same Claude account</b> Claude Code uses on that computer.</li>
    <li>Run <span class="mono">claude --chrome</span> once in a terminal there and let it connect (it sets up the link between Claude Code and Chrome), then close it.</li>
    <li>In the JOYA AI app: Settings &#9656; This computer &#9656; <b>Look again</b>. This page then shows the extension.</li>
  </ol>`;

function chromeBlock(m, csrf) {
  const s = chromeState(m);
  const cls = { connected: "ok", "set-up": "ok", "not-connected": "warn", missing: "warn", off: "neutral", unknown: "neutral" }[s.state];
  const toggle =
    m.chrome && m.chrome.extension !== undefined
      ? `<form method="post" action="/machines/${m.id}/browser" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="on" value="${m.chrome.allowed === false ? "1" : "0"}"><button class="btn ghost small" type="submit">${m.chrome.allowed === false ? "Let JOYA AI use Chrome" : "Switch Chrome off"}</button></form>`
      : "";
  const needsSteps = s.state === "missing" || s.state === "not-connected" || s.state === "unknown";
  return `<div class="mc-chrome" data-chrome="${m.id}" data-chrome-state="${s.state}" data-chrome-sig="${chromeSig(m.chrome)}">
      <div class="mc-chrome-head"><span class="pill ${cls} nodot" data-chrome-pill="${m.id}">${esc({ connected: "Chrome connected", "set-up": "Chrome set up", "not-connected": "Chrome not connected", missing: "Chrome not set up", off: "Chrome off", unknown: "Chrome unknown" }[s.state])}</span> <span class="small">${s.text}</span> ${toggle}</div>
      ${needsSteps ? `<details class="mc-steps"${s.state === "missing" || s.state === "not-connected" ? " open" : ""}><summary class="small">How to connect Chrome</summary>${SETUP_STEPS}<p class="muted small">JOYA AI then works in your own Chrome, through the extension only. Anything that sends, submits, buys, posts or deletes waits for your approval (Windows Hello); it may press Sign in, but never types passwords, PINs, codes or payment details.</p></details>` : ""}
    </div>`;
}

function foldersBlock(m, csrf) {
  const list = (m.folders || [])
    .map(
      (f) => `<li><span class="mono small">${esc(f)}</span> <form method="post" action="/machines/${m.id}/folders/remove" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="path" value="${esc(f)}"><button class="btn ghost small" type="submit" title="Remove">${icon("close", 12)}</button></form></li>`
    )
    .join("");
  return `<details class="mc-folders" data-folders="${m.id}"><summary class="small">Folders JOYA AI may use: Documents, Desktop, Downloads, OneDrive${(m.folders || []).length ? ` + ${(m.folders || []).length} more` : ""}</summary>
      ${list ? `<ul class="mc-folder-list">${list}</ul>` : ""}
      <form method="post" action="/machines/${m.id}/folders" class="mc-folder-add"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input name="path" placeholder="D:\\Work\\Projects" maxlength="240" required aria-label="Folder path on that computer"><button class="btn small" type="submit">${icon("plus", 12)} Add folder</button></form>
      <p class="muted small">Office, PDF and file steps stay inside these folders. Windows, program and app-data folders cannot be added.</p>
    </details>`;
}

function takeOverForm(m, csrf) {
  if (!m.online || m.lease) return "";
  if (m.claude && !m.claude.found) return claudeMissingNote(m);
  return `<details class="mc-take"><summary>Let JOYA AI take over</summary>
      <form method="post" action="/machines/${m.id}/take-over" class="stack">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>What should it do?<textarea name="purpose" rows="3" minlength="10" maxlength="4000" required placeholder="e.g. Update the totals in Budget.xlsx and make a PDF of the Q3 deck."></textarea></label>
        <label>For <select name="minutes"><option value="15" selected>15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></label>
        <button class="btn primary" type="submit">${icon("core", 14)} Take over</button>
        <p class="muted small">You will see a glowing frame on that computer; Ctrl+Alt+Esc there stops it. Sending, submitting, buying, posting, deleting, installing or writing over a file waits for your approval.</p>
      </form></details>`;
}

function machineRow(m, csrf) {
  const claude = claudeStatus(m);
  const office = m.office && m.office.length ? `Office: ${esc(m.office.join(", "))}` : m.chrome ? "Office: not installed" : "";
  return `<li class="mc-row" data-mid="${m.id}" id="machine-${m.id}">
      <div class="mc-main">
        <div class="mc-title">${icon("monitor", 18)}<b>${esc(m.name)}</b> ${onlinePill(m)}</div>
        <div class="muted small">${m.host ? esc(m.host) + " · " : ""}app ${esc(m.app_version || "?")}${claude ? " · " + claude : ""}${office ? " · " + office : ""} · ${m.online ? "linked now" : m.last_seen_at ? "last seen " + esc(ago(m.last_seen_at)) : "never linked"}</div>
        ${chromeBlock(m, csrf)}
        ${leaseBlock(m, csrf)}
        ${takeOverForm(m, csrf)}
        ${foldersBlock(m, csrf)}
      </div>
      <div class="mc-side">
        <a class="btn ghost" href="/machines/${m.id}">Activity</a>
        <details class="mc-more"><summary class="btn ghost">More</summary>
          <form method="post" action="/machines/${m.id}/rename" class="stack"><input type="hidden" name="_csrf" value="${esc(csrf)}">
            <label>Name<input name="name" value="${esc(m.name)}" maxlength="48" required></label><button class="btn" type="submit">Rename</button></form>
          <form method="post" action="/machines/${m.id}/revoke" class="stack"><input type="hidden" name="_csrf" value="${esc(csrf)}">
            <p class="muted small">Revoking unlinks this computer at once (and ends any control). It must be paired again to be used.</p>
            <button class="btn danger" type="submit">${icon("stop", 14)} Revoke</button></form>
        </details>
      </div>
    </li>`;
}

/** /machines */
function list(o) {
  const ms = o.machines || [];
  const pair = o.code
    ? `<div class="mc-code" id="pair-code"><div class="muted small">Pairing code, valid until ${when(o.code.expires_at)}</div><div class="mc-code-value mono">${esc(o.code.code)}</div>
        <ol class="steps"><li>On the computer, open JOYA AI (the desktop app) > tray > Settings > This computer.</li><li>Type this code and press Link.</li><li>It appears here as online.</li></ol>
        <p class="muted small">The code works once, for ${esc(String(o.code.minutes))} minutes. Never read it to anyone.</p></div>`
    : `<form method="post" action="/machines/pair"><input type="hidden" name="_csrf" value="${esc(o.csrf)}"><button class="btn primary" type="submit">${icon("plus", 14)} Pair a computer</button></form>`;
  const body =
    (o.msg ? `<div class="alert ok">${icon("check")}<div>${esc(o.msg)}</div></div>` : "") +
    (o.err ? `<div class="alert bad">${icon("alert")}<div>${esc(o.err)}</div></div>` : "") +
    card("Your computers", ms.length ? `<ul class="mc-list" id="mc-list">${ms.map((m) => machineRow(m, o.csrf)).join("")}</ul>` : empty("monitor", "No computer is linked yet", "Pair one below: JOYA AI can then work on it when you ask."), { icon: "monitor", id: "computers" }) +
    card(
      "Pair a computer",
      `<p>Link a Windows computer that runs the JOYA AI desktop app. JOYA AI can then work there <b>when you ask</b>: read, write and edit your files, run PowerShell commands, open files and apps, make Word, Excel and PowerPoint files, edit existing ones (a new copy by default), read and merge PDFs, and — when you connect the Claude in Chrome extension there — use your own Chrome. It has <b>no</b> other screen, mouse or keyboard control.</p><p class="muted small">Needs Claude Code on that computer: install it and sign in once by running <span class="mono">claude</span> in a terminal.</p>${pair}`,
      { icon: "plus", id: "pair" }
    ) +
    card(
      "How control works",
      `<ul class="bullets">
        <li><b>Only when you ask.</b> JOYA AI takes over for your own request (typed, or said aloud when the voiceprint recognises you), never on its own.</li>
        <li><b>A lease.</b> 15 minutes by default; extend it here or on the computer. It ends on stop, timeout, lock or sign-out.</li>
        <li><b>Always visible.</b> A glowing frame and a pill on the computer, with its last action; <span class="mono">Ctrl+Alt+Esc</span> stops it instantly, on the computer itself.</li>
        <li><b>Your approval</b> (Windows Hello) before sending, submitting, buying, posting, deleting, installing, writing over a file or touching files outside yours: the usual approval cards.</li>
        <li><b>Your files stay yours.</b> Office edits go to a new copy next to the original; macros never run.</li>
        <li><b>Never</b> passwords, card numbers or ids typed; never CAPTCHAs; Windows security prompts are yours.</li>
        <li><b>A log</b> of every action — what, on what, the result and who approved it — kept ${esc(String(o.retention))} days.</li>
      </ul>`,
      { icon: "shield", id: "safety" }
    );
  return shell("Computers", body + kindIcons(), { user: o.user, csrf: o.csrf, active: "machines", heading: "Computers", subtitle: "Your own computers, linked through the JOYA AI desktop app", assets: ["machines.css", "machines.js"] });
}

/** /machines/:id: a computer's control sessions. */
function detail(o) {
  const m = o.machine;
  const rows = (o.leases || [])
    .map(
      (l) => `<tr><td><a href="/machines/${m.id}/lease/${l.id}">${when(l.started_at)}</a></td><td>${esc(l.started_by === "joya-ai" ? "JOYA AI" : l.started_by || "")}</td><td>${esc(l.purpose || "")}</td><td>${l.ended_at ? esc(l.end_reason || "ended") : `<span class="pill ok">active</span>`}</td><td class="num">${esc(String(l.actions || 0))}</td></tr>`
    )
    .join("");
  const s = chromeState(m);
  const body =
    card(m.name, `<p class="muted small">${m.online ? "Online now" : "Offline"} · app ${esc(m.app_version || "?")}${m.claude ? " · " + claudeStatus(m) : ""} · paired ${when(m.created_at)} by ${esc(m.created_by || "?")}</p><p class="small">${s.text}</p>`, { icon: "monitor" }) +
    card("Control sessions", rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th>By</th><th>What for</th><th>End</th><th class="num">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("activity", "Nothing yet", "JOYA AI has not controlled this computer."), { icon: "activity" });
  return shell(m.name, body, { user: o.user, csrf: o.csrf, active: "machines", heading: m.name, crumbs: [["Computers", "/machines"], [m.name, null]], assets: ["machines.css"] });
}

/** /machines/:id/lease/:lid: the action log, live while the take-over runs (and an old one's screenshots). */
function leaseLog(o) {
  const m = o.machine;
  const l = o.lease;
  const log = o.log || [];
  const last = log.length ? log[log.length - 1].id : 0;
  const olds = (o.actions || [])
    .map(
      (a) => `<li class="mc-act" data-aid="${a.id}">
        ${a.shot ? `<a href="/machines/shot/${a.id}" target="_blank" rel="noopener" class="mc-shot"><img src="/machines/shot/${a.id}" alt="Screen after: ${esc(a.summary || a.tool)}" loading="lazy"></a>` : `<div class="mc-shot none">no screenshot</div>`}
        <div><div class="mono small">${when(a.at)} · ${esc(a.tool)} · <span class="pill ${a.decision === "approved" || a.decision === "auto" ? "ok" : a.decision === "error" ? "warn" : "bad"} nodot">${esc(a.decision || "")}</span></div><div>${esc(a.summary || "")}</div></div>
      </li>`
    )
    .join("");
  const counts = log.reduce((c, a) => ((c[a.kind] = (c[a.kind] || 0) + 1), c), {});
  const sumLine = log.length ? `${log.length} action${log.length === 1 ? "" : "s"}: ${["hands", "browser", "cli"].filter((k) => counts[k]).map((k) => `${counts[k]} ${KIND[k][1].toLowerCase()}`).join(", ")} · ${log.filter((a) => a.decision === "approved").length} approved by you · ${log.filter((a) => a.result !== "ok").length} failed or refused` : "";
  const body =
    card(
      "Control session",
      `<p>${esc(l.purpose || "")}</p><p class="muted small">Started ${when(l.started_at)} by ${esc(l.started_by === "joya-ai" ? "JOYA AI" : l.started_by || "?")} · ${l.ended_at ? "ended " + when(l.ended_at) + " (" + esc(l.end_reason || "") + ")" : `<span class="pill ok">live</span> until ` + when(l.expires_at)}</p>${sumLine ? `<p class="small" data-log-sum>${esc(sumLine)}</p>` : ""}`,
      { icon: "core" }
    ) +
    card(
      "What it did",
      `<ol class="mc-log full" id="mc-log" data-live-log="${l.id}" data-after="${esc(String(last))}" data-active="${l.ended_at ? "0" : "1"}">${log.map(actionRow).join("") || `<li class="mc-log-empty muted small">No actions yet.${l.ended_at ? "" : " Each one shows here as it happens."}</li>`}</ol><p class="muted small">Times are UTC. Kept ${esc(String(o.retention || 90))} days.</p>`,
      { icon: "activity" }
    ) +
    (olds ? card("Screenshots (older app)", `<ol class="mc-acts" id="mc-acts" data-lease="${l.id}" data-active="0">${olds}</ol>`, { icon: "image" }) : "");
  return shell("Control log", body + kindIcons(), { user: o.user, csrf: o.csrf, active: "machines", heading: "Control log", crumbs: [["Computers", "/machines"], [m.name, `/machines/${m.id}`], ["Log", null]], assets: ["machines.css", "machines.js"] });
}

module.exports = { list, detail, leaseLog, actionRow, chromeState, toolName };
