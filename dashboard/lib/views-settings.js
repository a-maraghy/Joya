"use strict";
/**
 * JOYA AI ▸ Settings (/joya-ai/settings/<section>): every setting of JOYA AI
 * in one place, in nine sections (Advanced joined General on 2026-10-25). The left sub-nav becomes a chip row on a
 * narrow screen.
 *
 * Every setting is a row: label and help on the left, the control on the
 * right, and a scope tag saying who it applies to -- everyone, you, this
 * browser, or config (read from the supervisor's config file, changed by a
 * deploy). A row that changes something is a small form: it posts to its own
 * route and works without JavaScript (the route redirects back here with a
 * note); os.js sends it in place instead ([data-live] forms) and shows the
 * same note without a reload.
 *
 * Who sees what (all need joyaai.use): Voice needs voice.manage; Appearance
 * and Briefs & watchers are the viewer's own; every other section is the administrator's. The
 * sections a viewer may not open are not listed.
 *
 * The Voice section's body is lib/views-settings-voice.js; the rest are here.
 */

const { esc, shell, icon, flashes } = require("./ui");

/** The sections, in order: [key, label, icon]. The page registry reads this. */
const SETTINGS_SECTIONS = [
  ["general", "General", "core"],
  ["voice", "Voice", "voice"],
  ["chatgpt", "ChatGPT", "network"],
  ["appearance", "Appearance", "eye"],
  ["sessions", "Sessions & hiring", "agents"],
  ["screen", "Screen control", "monitor"],
  ["approvals", "Approvals & automations", "shield"],
  ["proactive", "Briefs & watchers", "clock"],
  ["usage", "Usage & token caps", "activity"],
];

/** May this actor open that section? */
function mayOpen(perm, key) {
  if (!perm) return false;
  if (!perm.can("joyaai.use")) return false;
  if (key === "voice") return perm.can("voice.manage");
  // Appearance is the viewer's own (their core, their sessions view).
  if (key === "appearance") return true;
  // Briefs & watchers are the viewer's own too (lib/routes-proactive.js).
  if (key === "proactive") return true;
  return !!perm.admin;
}

/** The sections this actor may open. */
function sectionsFor(perm) {
  return SETTINGS_SECTIONS.filter((s) => mayOpen(perm, s[0]));
}

/* ---------------------------------------------------------------- pieces --- */

/** A scope tag: everyone / you / this browser / config, or any short text. */
function scopeTag(scope) {
  return scope ? ` <span class="scope">${esc(scope)}</span>` : "";
}

/**
 * One setting row. `label` and `help` are trusted markup (callers escape what
 * they did not write); `control` is markup.
 *   o.scope  the scope tag     o.tag   extra markup after the label
 *   o.id     an anchor         o.full  the control on its own line below
 *   o.dep    dims when its section is switched off (voice)
 */
function row(label, help, control, o = {}) {
  return `<div class="row${o.full ? " full" : ""}${o.dep ? " dep" : ""}"${o.id ? ` id="${esc(o.id)}"` : ""}><div class="rl"><b>${label}${scopeTag(o.scope)}${o.tag || ""}</b>${
    help ? `<p>${help}</p>` : ""
  }</div><div class="rc">${control}</div></div>`;
}

/** A group of rows under a small heading. `o.aside` sits at the heading's right. */
function group(title, ic, body, o = {}) {
  return `<div class="group${o.cls ? " " + esc(o.cls) : ""}"${o.id ? ` id="${esc(o.id)}"` : ""}><div class="gh">${icon(ic, 16)}${esc(title)}${
    o.aside ? `<span class="aside">${o.aside}</span>` : ""
  }</div>${body}</div>`;
}

/**
 * "More": rows that are rarely needed (diagnostics, defaults nobody changes),
 * closed by default and opened with one click. A plain <details>, so it works
 * by keyboard and without script. `o.open` opens it (a result to show).
 */
function more(summary, body, o = {}) {
  return `<details class="set-more"${o.id ? ` id="${esc(o.id)}"` : ""}${o.open ? " open" : ""}><summary>${esc(summary)}</summary><div class="set-more-body">${body}</div></details>`;
}

/** A read-only value from the supervisor's config. */
function ro(v) {
  return `<span class="muted-num">${esc(v == null || v === "" ? "—" : v)}</span> <span class="tag-s ro" title="Read from the supervisor's config file; changed by a deploy">config</span>`;
}

/** A switch. `attrs` is trusted markup (name, data-*). */
function sw(attrs, on, onT, offT, cls) {
  return `<label class="sw${cls ? " " + esc(cls) : ""}"><input type="checkbox" ${attrs}${on ? " checked" : ""}><span class="tr"></span><span class="on-t">${esc(
    onT == null ? "On" : onT
  )}</span><span class="off-t">${esc(offT == null ? "Off" : offT)}</span></label>`;
}

/** A segmented choice posting `name` (radio buttons styled as the theme switch). */
function seg(name, opts, cur) {
  return `<div class="theme-seg seg-radio" role="radiogroup">${opts
    .map(
      ([v, l]) =>
        `<label class="seg-opt"><input type="radio" name="${esc(name)}" value="${esc(v)}"${v === cur ? " checked" : ""}><span>${esc(l)}</span></label>`
    )
    .join("")}</div>`;
}

function opt(v, l, cur) {
  return `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`;
}

/**
 * A small form around a control. It posts to `action` with the CSRF token;
 * os.js sends it as soon as a control in it changes ([data-live]), and a
 * number field on Enter or when it loses focus. Without JavaScript the
 * `button` (if any) submits it.
 */
function form(action, csrf, inner, o = {}) {
  return `<form method="post" action="${esc(action)}" class="set-form${o.cls ? " " + esc(o.cls) : ""}" data-live${o.confirm ? ` data-confirm-dlg="${esc(o.confirm)}"` : ""}${
    o.confirmBody ? ` data-confirm-body="${esc(o.confirmBody)}"` : ""
  }${o.confirmYes ? ` data-confirm-yes="${esc(o.confirmYes)}"` : ""}><input type="hidden" name="_csrf" value="${esc(csrf)}">${inner}${
    o.noSave ? "" : `<noscript><button class="btn small" type="submit">Save</button></noscript>`
  }</form>`;
}

/** A link row: title, description, a button. */
function linkRow(title, desc, href, label, attrs) {
  return `<div class="lr"><div>${title ? `<b>${esc(title)}</b>` : ""}<span class="d">${desc}</span></div><a class="btn small" href="${esc(href)}"${attrs || ""}>${esc(label || "Open")}</a></div>`;
}

/* -------------------------------------------------------------- the page --- */

/**
 * @param o { user, csrf, section, body, status, msg, err, assets }
 *   status  per-section status marks for the sub-nav: { voice: "on"|"off", usage: "cap" }
 */
function page(o) {
  const perm = o.user && o.user.perm;
  const secs = sectionsFor(perm);
  const cur = secs.find((s) => s[0] === o.section) || secs[0];
  const marks = o.status || {};
  const nav = secs
    .map(([k, label, ic]) => {
      const m = marks[k];
      const st = m ? `<span class="st${m === "off" ? " off" : m === "cap" ? " warn" : ""}">${esc(m)}</span>` : "";
      return `<a href="/joya-ai/settings/${k}"${k === cur[0] ? ' class="on" aria-current="page"' : ""}>${icon(ic, 16)}${esc(label)}${st}</a>`;
    })
    .join("");
  return shell(
    "JOYA AI Settings",
    `<div class="flash-slot" id="flash" role="status">${flashes({ msg: o.msg, err: o.err })}</div>
    <div class="set-wrap"><nav class="set-nav" aria-label="Settings sections">${nav}</nav>
      <div class="set-sec${o.secClass ? " " + esc(o.secClass) : ""}" id="set-sec">${o.body}</div></div>`,
    {
      user: o.user,
      csrf: o.csrf,
      active: "joya-settings",
      heading: "JOYA AI Settings",
      subtitle: "Every setting of JOYA AI, in one place.",
      crumbs: [
        ["JOYA AI", "/joya-ai"],
        ["Settings", "/joya-ai/settings"],
        [cur[1], null],
      ],
      pattern: "c",
      assets: o.assets || [],
    }
  );
}

/** The section's heading and lead paragraph. `lead` is trusted markup. */
function head(title, lead) {
  return `<h2>${esc(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}`;
}

module.exports = {
  SETTINGS_SECTIONS,
  mayOpen,
  sectionsFor,
  scopeTag,
  row,
  group,
  ro,
  sw,
  seg,
  opt,
  form,
  linkRow,
  more,
  head,
  page,
};
