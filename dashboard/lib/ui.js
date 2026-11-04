"use strict";
/**
 * Page chrome: a top bar that says where you are, and one left sidebar
 * carrying everything in Joya.
 *
 * The top bar answers "where am I, and does anything need me": the page's
 * place in the navigation, the Decisions waiting in the Command Center, the
 * health of the machine, and the avatar menu (account, devices, theme, sign
 * out). The sidebar answers "what can I open", in five groups: JOYA AI,
 * Agents & sessions, Machine, Access & security, Help.
 *
 * Server-rendered, no client framework, no external assets: the CSP blocks
 * them, and a panel that can grant SSH access is the last place to be pulling
 * scripts off a CDN.
 */

const fs = require("fs");
const path = require("path");
const { icon } = require("./icons");
const { landing } = require("./rbac");
const brand = require("./brand");

/**
 * Cache-busting stamps for the static files.
 *
 * /static is served with a long cache, which is right for bytes that do not
 * change and wrong for bytes that just did: a deployed stylesheet could take an
 * hour to reach a browser that already had the old one, so a fix looked like it
 * had not shipped. The stamp changes when the file does, which makes the URL
 * change, which is the only thing a cache reliably notices.
 *
 * Read once at startup. These files are only replaced by a deploy, and a deploy
 * restarts the process.
 */
const ASSET_VERSIONS = new Map();

function asset(file) {
  if (!ASSET_VERSIONS.has(file)) {
    let stamp = "0";
    try {
      const { mtimeMs, size } = fs.statSync(path.join(__dirname, "..", "public", file));
      stamp = Math.round(mtimeMs).toString(36) + "-" + size.toString(36);
    } catch (_) {
      /* a missing file is the static handler's problem to report, not ours */
    }
    ASSET_VERSIONS.set(file, stamp);
  }
  return "/static/" + file + "?v=" + ASSET_VERSIONS.get(file);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function stamp(iso) {
  return String(iso || "").replace("T", " ").slice(0, 19) || "—";
}

/* ------------------------------------------------------- navigation model - */

/**
 * One sidebar for the whole OS, in five groups on two levels (the 2026-09-30
 * reorganisation). The top bar says where you are; it no longer switches
 * between dashboards -- the three "worlds" of the old bar are groups here.
 *
 * Each item names the permission that reveals it (or a `when(perm)` test for
 * the ones that need more than one), and a group whose items are all hidden
 * collapses away, so a viewer's sidebar is short rather than mostly dead links.
 * `key` is what a page passes as `active`; ALIASES maps the keys pages used
 * before (and pages that live under an item) onto the item that lights up.
 */
const NAV = [
  {
    key: "joya-ai",
    label: "JOYA AI",
    items: [
      { key: "joya-ai", href: "/joya-ai", label: "Command Center", icon: "core", ai: true, perm: "joyaai.use" },
      {
        key: "joya-settings",
        href: "/joya-ai/settings",
        label: "Settings",
        icon: "settings",
        // Appearance is anyone's who uses JOYA AI; Voice needs voice.manage;
        // the rest is the administrator's (lib/views-settings.js).
        perm: "joyaai.use",
      },
      // The user's own computers, linked through the desktop app (lib/routes-machines.js).
      { key: "machines", href: "/machines", label: "Computers", icon: "monitor", perm: "joyaai.use" },
    ],
  },
  {
    key: "agents",
    label: "Agents & sessions",
    items: [
      { key: "agents-dashboard", href: "/agents/dashboard", label: "Agents overview", icon: "overview", when: (p) => p.can("agents.view") || p.can("claude.running.view") },
      { key: "claude-sessions", href: "/claude/sessions", label: "Sessions", icon: "activity", when: (p) => p.can("claude.sessions.view") || p.can("claude.running.view") },
      { key: "agents", href: "/agents", label: "Telegram agents", icon: "agents", perm: "agents.view" },
      { key: "channels", href: "/channels", label: "Channels", icon: "channels", perm: "channels.view" },
      { key: "addons", href: "/addons", label: "Add-ons", icon: "addons", perm: "addons.view" },
      { key: "claude-memory", href: "/claude/memory", label: "Memory", icon: "memory", perm: "claude.memory.read" },
    ],
  },
  {
    key: "machine",
    label: "Machine",
    items: [
      { key: "os", href: "/os", label: "Machine health", icon: "cpu", perm: "os.view" },
      { key: "services", href: "/services", label: "Services", icon: "services", when: (p) => p.can("services.view") || p.can("agents.view") },
      { key: "audit", href: "/audit", label: "Audit log", icon: "audit", perm: "audit.view" },
    ],
  },
  {
    key: "access",
    label: "Access & security",
    items: [
      { key: "users", href: "/users", label: "Users", icon: "users", perm: "users.view" },
      { key: "roles", href: "/roles", label: "Roles", icon: "shield", perm: "roles.view" },
      // Every signed-in person sees their own signed-in browsers.
      { key: "devices", href: "/devices", label: "Devices", icon: "devices" },
      { key: "keys", href: "/keys", label: "SSH keys", icon: "keys", perm: "keys.view" },
      { key: "firewall", href: "/firewall", label: "Firewall", icon: "ban", perm: "firewall.view" },
      { key: "credentials", href: "/credentials", label: "Credentials", icon: "credentials", perm: "credentials.view" },
    ],
  },
];
// The Guide moved from a one-item "Help" group to the avatar menu ("Guide & help", 2026-10-25).

/** Keys pages pass that are not items of their own, and the item they sit under. */
const ALIASES = {
  "claude-running": "claude-sessions",
  running: "claude-sessions",
  sessions: "claude-sessions",
  memory: "claude-memory",
  "agent-services": "services",
  console: "joya-ai",
  "voice-settings": "joya-settings",
};

/** May this actor see the item? A missing actor (setup pages) sees everything. */
function allowed(item, perm) {
  if (!perm) return true;
  if (item.perm && !perm.can(item.perm)) return false;
  if (item.when && !item.when(perm)) return false;
  return true;
}

/** Where an active key sits: { group, item } or null. */
function locate(active) {
  const key = ALIASES[active] || active;
  for (const group of NAV) {
    const item = group.items.find((i) => i.key === key);
    if (item) return { group, item };
  }
  return null;
}

/** The first item of a group this actor may open -- where the group's crumb goes. */
function groupHref(group, perm) {
  const first = group.items.find((i) => allowed(i, perm));
  return first ? first.href : null;
}

/**
 * The trail above a page title: group / page. Pages deeper than the
 * navigation (an agent, a fact) pass their own trail as opts.crumbs, a list of
 * [label, href] pairs; the last is where you are and is not a link.
 */
function renderCrumbs(active, perm, crumbs) {
  let trail = crumbs;
  if (!trail) {
    const at = locate(active);
    if (!at) return "";
    trail = [[at.group.label, groupHref(at.group, perm)], [at.item.label, at.item.href]];
  }
  return `<nav class="crumbs" aria-label="Breadcrumb">${trail
    .map(([label, href], i) =>
      (i ? `<span aria-hidden="true">/</span>` : "") +
      (href && i < trail.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)
    )
    .join("")}</nav>`;
}

/** The top bar's "where you are": group / page, or the page's own name. */
function renderWhere(active, fallback) {
  const at = locate(active);
  if (at) return `<span class="g">${esc(at.group.label)}</span><span class="sep">/</span><b>${esc(at.item.label)}</b>`;
  return fallback ? `<b>${esc(fallback)}</b>` : "";
}

/**
 * A sidebar badge. Counts are quiet (plain, and a zero is hidden); only states
 * are tinted. `b` is [text, cls, title?]: the text is what the item shows, the
 * title the full sentence (a state badge shows "4" and says "4 live").
 */
function badgeHtml(key, b) {
  if (!b) return "";
  const text = String(b[0] == null ? "" : b[0]);
  const cls = b[1] || "plain";
  if (cls === "plain" && (text === "" || text === "0")) return "";
  // The title is the full sentence for a pointer; the hidden span says it to a screen reader,
  // so a red "1" never carries its meaning by colour alone.
  return `<span class="badge ${esc(cls)}" data-badge="${esc(key)}"${b[2] ? ` title="${esc(b[2])}"` : ""}>${esc(text)}${b[2] ? `<span class="sr">: ${esc(b[2])}</span>` : ""}</span>`;
}

function renderSidebar(active, perm, chrome) {
  const at = locate(active);
  const badges = (chrome && chrome.badges) || {};
  const link = (i) => {
    const on = !!(at && at.item === i);
    return `<a href="${i.href}" class="side-item${on ? " on" : ""}"${on ? ' aria-current="page"' : ""} title="${esc(i.label)}">${
      icon(i.icon)
    }<span>${esc(i.label)}</span>${badgeHtml(i.key, badges[i.key])}</a>`;
  };
  const groups = NAV.map((g) => {
    const items = g.items.filter((i) => allowed(i, perm));
    if (!items.length) return "";
    return `<div class="side-group" data-g="${esc(g.key)}"><button type="button" class="side-label" aria-expanded="true" data-side-group="${esc(g.key)}">${esc(
      g.label
    )}${icon("chevron").replace('class="ico"', 'class="ico car"')}</button><div class="side-items">${items.map(link).join("")}</div></div>`;
  })
    .filter(Boolean)
    .join("");

  const id = chrome && chrome.ids && chrome.ids.os;
  const h = chrome && chrome.health;
  const idBlock = id
    ? `<div class="side-id"><span class="side-id-mark">${icon("cpu", 18)}${
        h ? `<span class="hd${h.cls === "ok" ? "" : " " + esc(h.cls)}" title="${esc(h.text)}"></span>` : ""
      }</span>
        <div><b>${esc(id.name)}</b><div class="facts">${(id.facts || [id.sub]).map((f) => `<span>${esc(f)}</span>`).join("")}</div></div></div>`
    : "";

  return `<div class="side-scroll">${idBlock}<nav aria-label="Section navigation">${groups}</nav></div>
    <div class="side-foot">
      <button class="side-collapse" type="button" data-side-collapse aria-expanded="true" title="Collapse the sidebar to icons">${icon(
        "sidebar",
        16
      )}<span>Collapse to icons</span></button>
    </div>`;
}

/** The health chip: one line saying whether anything needs you. */
function healthChip(chrome) {
  const h = chrome && chrome.health;
  if (!h) return "";
  return `<a class="sys-chip ${esc(h.cls)}" href="${esc(h.href)}" data-health title="${esc(h.text)}">
    <span class="dot${h.cls === "ok" ? "" : " " + esc(h.cls)}"></span><span class="long">${esc(h.text)}</span><span class="short">${esc(h.short)}</span></a>`;
}

/**
 * "N needs you": the Decisions waiting in the Command Center. Rendered hidden
 * when the count is not known yet; the dock (joya-dock.js) keeps it current.
 */
function needPill(n) {
  const k = Number(n) || 0;
  return `<a class="tb-need" id="tb-need" href="/joya-ai#dec" title="Decisions waiting for you in the Command Center"${k ? "" : " hidden"}><span class="dot"></span><span id="tb-need-n">${k}</span><span class="long">&nbsp;${
    k === 1 ? "needs" : "need"
  } you</span></a>`;
}

/** The avatar: its button, and the menu it opens (os.js wires it). */
function avatarMenu(who, perm, csrf) {
  const name = String(who.name || "");
  const initial = esc((name.trim()[0] || "?").toUpperCase());
  const role = who.roleLabel || "";
  const all = perm && perm.admin ? " · all permissions" : "";
  const settings = perm && perm.can("joyaai.use");
  return `<button class="avatar-btn" type="button" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="me-menu" title="${esc(name)}"><span class="avatar">${initial}</span><span class="who"><b>${esc(
    name
  )}</b>${role ? `<small>${esc(role)}</small>` : ""}</span></button>
  <div class="me-menu" id="me-menu" role="menu" hidden>
    <div class="mh"><span class="avatar">${initial}</span><div><b>${esc(name)}</b><small>${esc(role)}${all}</small></div></div>
    <a href="/account" role="menuitem">${icon("user")}Account &amp; sign-in</a>
    <a href="/devices" role="menuitem">${icon("devices")}Signed-in devices</a>
    ${settings ? `<a href="/joya-ai/settings/appearance" role="menuitem">${icon("eye")}JOYA AI appearance</a>` : ""}
    <a href="/guide" role="menuitem">${icon("guide")}Guide &amp; help</a>
    <div class="lbl">Theme</div>
    ${themeSwitch()}
    <hr>
    <form method="post" action="/logout" class="me-logout" data-confirm-dlg="Sign out of Joya?" data-confirm-body="This browser's session ends. Any live voice call on it ends too." data-confirm-yes="Sign out">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="mi" type="submit" role="menuitem">${icon("power")}Sign out</button>
    </form>
  </div>`;
}

/**
 * @param title   browser title
 * @param body    page markup
 * @param opts    { user, csrf, active, subtitle, actions, wide, perm, bare,
 *                  pageClass, topExtra, topEnd, assets, pattern, crumbs,
 *                  heading, headClass, where }
 *
 * `pattern` is how the page uses the screen: "a" one screen (nothing but
 * inner panels scrolls), "b" a fixed frame whose body panel scrolls, "c" a
 * document whose column scrolls under the frame (the default). `bare` is the
 * Command Center: it lays out its own screen, and the sidebar is a drawer its
 * ☰ opens. `topExtra` replaces the needs-you pill and health chip (the Command
 * Center brings its own), `topEnd` goes before the avatar (its clock). `where`
 * names the page in the top bar when it is not a sidebar item. `assets` are
 * extra files from public/ -- .css as stylesheets, .js as deferred scripts.
 */
function shell(title, body, opts = {}) {
  // `user` is the viewer context: routes pass the object built by ctx(), but a
  // bare username string still works, which keeps the signed-out and setup
  // pages -- the only callers that have no actor -- unchanged.
  const who = typeof opts.user === "string" ? { name: opts.user } : opts.user || null;

  if (!who || !who.name) {
    // Signed out: no chrome at all, just the card. Showing navigation you
    // cannot use is noise on the one screen that has to be unambiguous.
    // The JOYA wordmark heads the card (no leaf, 2026-10-25).
    const kind = opts.brand === "ai" ? "ai" : "os";
    const head = `<div class="auth-lockup">${brand.lockup(kind, { sub: true })}</div>`;
    const inner = /^\s*<div class="card">/.test(body) ? body.replace(/<div class="card">/, `<div class="card auth-card">${head}`) : head + body;
    return page(title, `<main class="auth-wrap">${inner}</main>`, opts);
  }

  const perm = who.perm || opts.perm || null;
  const chrome = who.chrome || null;
  const bare = !!opts.bare;
  opts = Object.assign({}, opts, { brand: opts.brand || "os" });
  const pattern = bare ? null : ["a", "b", "c"].includes(opts.pattern) ? opts.pattern : "c";

  const actions = [
    opts.statusChip ? `<span class="pill nodot mono">${opts.statusChip}</span>` : "",
    opts.actions || "",
  ].join("");

  const head =
    !bare && opts.heading !== null
      ? `<div class="page-head${opts.headClass ? " " + esc(opts.headClass) : ""}${opts.headArt ? " with-art" : ""}">
           ${opts.headArt ? `<div class="head-art">${opts.headArt}</div>` : ""}
           <div class="head-text">
             ${renderCrumbs(opts.active, perm, opts.crumbs)}
             <h1>${opts.headingHtml || esc(opts.heading || title)}</h1>
             ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ""}
           </div>
           ${actions ? `<div class="page-actions">${actions}</div>` : ""}
         </div>`
      : "";

  // JOYA AI's dock (M-5 part 1, public/joya-dock.js): on every page for anyone who may use JOYA AI,
  // except the Command Center, which is JOYA AI already. The content column ends above
  // the dock's band (with-dock), so the dock never covers what a page shows.
  const withDock = !bare && !!(perm && perm.can && perm.can("joyaai.use")) && opts.dock !== false;
  const pageClass = [bare ? "" : "framed", withDock ? "with-dock" : "", opts.pageClass || ""].filter(Boolean).join(" ");
  // Core D's dock draws the mesh itself (WebGL2, joya-core-d.js, loaded before joya-dock.js); A/B/C keep the dotted 2D one.
  // Core E's dock draws the bot head (WebGL2, joya-core-bot.js, with cc-logic.js for its colours).
  const dockCoreD = !!(who && who.core === "D");
  const dockCoreE = !!(who && who.core === "E");
  if (withDock) opts = Object.assign({}, opts, { assets: (opts.assets || []).concat(["joya-dock.css", "ui-actions.js"].concat(dockCoreD ? ["joya-core-d.js"] : [], dockCoreE ? ["cc-logic.js", "joya-core-bot.js"] : [], ["joya-dock.js"]).filter((f) => !(opts.assets || []).includes(f))) });

  const where = renderWhere(opts.active, opts.where || (opts.crumbs && opts.crumbs.length ? opts.crumbs[opts.crumbs.length - 1][0] : title));

  return page(
    title,
    `<a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <button class="nav-toggle" type="button" aria-label="Menu"
              aria-expanded="false" aria-controls="sidebar"
              ${bare ? "data-os-toggle" : "data-nav-toggle"}>${icon("menu", 20)}</button>
      <a class="brand" href="${perm ? landing(perm) : "/"}" aria-label="Joya">
        ${brand.lockup("os", { cls: "brand-text", tag: false })}
      </a>
      <div class="tb-where" id="tb-where">${where}</div>
      <div class="top-right">
        ${opts.topExtra ? opts.topExtra : needPill(0) + healthChip(chrome)}
        ${opts.topEnd || ""}
        ${avatarMenu(who, perm, opts.csrf)}
      </div>
    </header>

    <div class="nav-scrim" data-nav-close hidden></div>
    ${bare ? `<div class="os-scrim" id="os-scrim" data-os-close hidden></div>` : ""}

    <div class="layout${bare ? " bare" : ""}">
      <aside class="sidebar" id="sidebar" aria-label="Sidebar">${renderSidebar(opts.active, perm, chrome)}</aside>
      <main class="content${opts.wide ? " wide" : ""}${bare ? " flush" : " pat-" + pattern}" id="main" tabindex="-1">
        ${head}
        ${bare ? body : `<div class="frame-body${opts.fill ? " stretch" : ""}">${body}</div>`}
      </main>
    </div>${withDock ? `<div class="dock-band" aria-hidden="true"></div>` + dockMarkup(opts.csrf, perm, { noVoice: !who.voice, core: who.core, botHead: who.botHead, botColors: who.botColors, botFace: who.botFace }) : ""}`,
    Object.assign({}, opts, { pageClass })
  );
}

/**
 * page.open's map for a page: the keys this viewer's role may open (data-pages)
 * and the allowed entries to check them against (data-page-map, JSON; the page
 * hands it to UiActions.setPages). The built-in pages until the first scan.
 */
function pageMapFor(perm) {
  const can = (p) => !perm || perm.can(p);
  let v = null;
  try {
    const PM = require("./page-map");
    if (PM.current()) v = PM.forViewer(perm);
  } catch (_) {
    v = null;
  }
  if (!v) {
    const UiActions = require("../public/ui-actions");
    const b = UiActions.BUILTIN_PAGES;
    v = { keys: UiActions.navKeysFor(can), map: Object.keys(b).map((k) => ({ key: k, url: b[k].url, label: b[k].label, perm: b[k].perm, kind: b[k].kind })) };
  }
  return { keys: v.keys.join(" "), map: JSON.stringify(v.map) };
}

/**
 * JOYA AI's dock on a page that is not the Command Center: its small core,
 * state and the last thing it said, the mic (it starts a live call: the
 * Command Center opens with this page in its frame and the call starts), and
 * a way back to the Command Center. `opts.noVoice`: voice is off, no key, or
 * this viewer has no voice.use -- then there is no mic at all. Everything else is public/joya-dock.js.
 * data-pages: the page.open keys this viewer's role may use (checked there
 * before moving).
 */
function dockMarkup(csrf, perm, opts = {}) {
  const { keys, map } = pageMapFor(perm);
  // The Command Center's shell (M-5 part 2): the same dock, driven by the Command Center, over a
  // same-origin frame that holds the other pages, and the canvas the core flies on between them.
  const shellParts = opts.shell
    ? `
  <iframe class="md-frame" id="md-frame" name="joya-frame" title="Joya page" hidden></iframe>
  <canvas class="md-hero" id="md-hero" aria-hidden="true"></canvas>`
    : "";
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return `
<div class="md-root${opts.shell ? " md-shell" : ""}" id="joya-dock-root" data-core="${opts.core === "D" || opts.core === "E" ? opts.core : "dots"}"${opts.core === "E" ? ` data-bot-head="${esc(opts.botHead || "")}" data-bot-face="${esc(opts.botFace || "smooth")}" data-bot-colors="${esc(opts.botColors || "")}"` : ""} data-csrf="${esc(csrf)}" data-pages="${esc(keys)}" data-page-map="${esc(map)}"${opts.shell ? ' data-shell="1"' : ""} hidden>${shellParts}
  <div class="md-bubble" id="md-bubble" aria-hidden="true" data-s="idle"><div class="b-top">JOYA AI · <b id="md-b-state">READY</b><span id="md-b-at">now</span></div><div class="b-you" id="md-b-you"></div><div class="b-cap" id="md-b-cap">Ready when you are.</div><div class="b-ask" id="md-b-ask" hidden></div>
    <div class="b-hint"><span>Click to open the Command Center</span>${opts.noVoice ? "" : `<span>the mic starts a live call</span>`}</div></div>
  <div class="md-toast" id="md-toast" role="status"><span class="t-ic" aria-hidden="true"></span><span id="md-t-txt"></span><button type="button" id="md-t-act" hidden>Undo</button><button type="button" id="md-t-no" hidden>Cancel</button></div>
  <div class="md-dock${opts.shell ? " off" : ""}" id="md-dock" data-s="idle" role="region" aria-label="JOYA AI">
    <a class="md-orb" id="md-orb" href="/joya-ai" aria-label="Open the Command Center"><canvas id="md-orb-c" aria-hidden="true"></canvas></a>
    <a class="md-txt" id="md-txt" href="/joya-ai"><span class="md-name">JOYA AI <span class="md-live-tag" id="md-live-t">LIVE</span><span class="md-need-n" id="md-need-n" hidden>1 needs you</span></span>
      <span class="md-state"><i></i><span id="md-state-t">Ready</span></span></a>
    <div class="md-btns">
      ${opts.noVoice ? "" : `<button type="button" class="md-btn md-mic" id="md-mic" aria-label="Start a live conversation" title="Start a live conversation">${svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>')}</button>`}
      ${opts.shell ? `<button type="button" class="md-btn md-end" id="md-end" aria-label="End the live call" title="End the live call">${svg('<path d="M3.5 14.5c4.7-4 12.3-4 17 0l-1.8 2.6-3.4-1.2-.4-2.4a11 11 0 0 0-5.8 0l-.4 2.4-3.4 1.2z"/>')}</button>` : ""}
      <a class="md-btn md-exp" id="md-exp" href="/joya-ai" aria-label="Open the Command Center" title="Open the Command Center">${svg('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>')}</a>
    </div>
  </div>
</div>`;
}

/**
 * System / Dark / Light. Rendered with System ticked; theme-init.js has already
 * applied the saved choice before paint, and app.js ticks the right button and
 * wires the clicks. Without JavaScript the page simply follows the system.
 */
function themeSwitch() {
  const opt = (value, iconName, label, title) =>
    `<button type="button" role="radio" data-theme-opt="${value}" aria-checked="${value === "system"}" title="${title}">${icon(iconName, 14)}<span>${label}</span></button>`;
  return `<div class="theme-seg" role="radiogroup" aria-label="Theme" data-theme-switch>
      ${opt("system", "monitor", "System", "Match the system setting")}${opt("dark", "moon", "Dark", "Dark")}${opt("light", "sun", "Light", "Light")}
    </div>`;
}

/**
 * The Joya icon ("Mesh", tools/make-app-icon.cjs), the same on every page.
 * 16 px is the pixel-fitted lines drawing, 32 px the dots one, `any` the full
 * drawing (light SVG); the .ico carries all three for whatever asks for one.
 * Everything is stamped by asset(), so a new icon reaches a browser on its next
 * page load instead of when a month-long cache runs out. The manifest makes the
 * panel installable as an app with the same icon (manifest() below).
 */
/*
 * Which icon set the pages link (2026-10-20): "mesh" -- the live Mesh icon (tools/make-app-icon.cjs) -- or
 * "bot", the core E head with the cap (tools/make-bot-icon.cjs, public/brand/bot/), live since desktop 0.1.9.
 * The switch is the dashboard's environment: JOYA_APP_ICON=bot (deploy/joya-dashboard.service sets it;
 * a restart applies a change); unset or anything else is Mesh.
 * The pages' links, the web manifest's icons and the root /favicon.ico (server.js) all follow it.
 */
const ICON_SETS = {
  mesh: { f16: "brand/favicon-16.svg", f32: "brand/favicon-32.svg", any: "favicon.svg", ico: "favicon.ico", a180: "brand/app-icon-180.png", a192: "brand/app-icon-192.png", a512: "brand/app-icon-512.png", mask: "brand/app-icon-maskable-512.png" },
  bot: { f16: "brand/bot/favicon-16.svg", f32: "brand/bot/favicon-32.svg", any: "brand/bot/favicon.svg", ico: "brand/bot/favicon.ico", a180: "brand/bot/app-icon-180.png", a192: "brand/bot/app-icon-192.png", a512: "brand/bot/app-icon-512.png", mask: "brand/bot/app-icon-maskable-512.png" },
};
function appIconSet() { return process.env.JOYA_APP_ICON === "bot" ? "bot" : "mesh"; }
/*
 * The browser-tab icon is the M monogram whatever the app icon is (2026-10-25,
 * tools/make-monogram.cjs): black on white, white on black in dark mode. The
 * apple-touch and manifest icons keep the app set above (the bot head live).
 */
const FAVICON = { f16: "brand/m/favicon-16.svg", f32: "brand/m/favicon-32.svg", any: "brand/m/favicon.svg", ico: "brand/m/favicon.ico" };
function appIcons() { return Object.assign({}, ICON_SETS[appIconSet()], FAVICON); }
function iconLinks() {
  const I = appIcons();
  return [
    `<link rel="icon" href="${asset(I.f16)}" type="image/svg+xml" sizes="16x16">`,
    `<link rel="icon" href="${asset(I.f32)}" type="image/svg+xml" sizes="32x32">`,
    `<link rel="icon" href="${asset(I.any)}" type="image/svg+xml" sizes="any">`,
    `<link rel="alternate icon" href="${asset(I.ico)}" type="image/x-icon" sizes="16x16 32x32 48x48">`,
    `<link rel="apple-touch-icon" href="${asset(I.a180)}" sizes="180x180">`,
    `<link rel="manifest" href="/manifest.webmanifest?v=${MANIFEST_VERSION()}">`,
  ].join("\n");
}

/**
 * The web app manifest, served at /manifest.webmanifest (server.js) -- public,
 * because a browser fetches it without the session cookie. Its icon URLs are
 * stamped like every other asset, and its own URL carries a stamp built from
 * them, so a new icon changes the manifest URL too.
 */
const APP_COLOURS = { background: "#0D1117", theme: "#0D1117" }; // Obsidian
function manifest() {
  return {
    id: "/",
    name: "Joya",
    short_name: "Joya",
    description: "Joya and JOYA AI",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: APP_COLOURS.background,
    theme_color: APP_COLOURS.theme,
    icons: [
      { src: asset(appIcons().a192), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: asset(appIcons().a512), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: asset(appIcons().mask), sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: asset(ICON_SETS[appIconSet()].any), sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
let manifestVersion = null;
function MANIFEST_VERSION() {
  if (manifestVersion === null) {
    manifestVersion = require("crypto").createHash("sha1").update(JSON.stringify(manifest())).digest("hex").slice(0, 10);
  }
  return manifestVersion;
}

function page(title, inner, opts = {}) {
  // Every page carries the Command Center's stylesheet too: its confirm
  // (.cc-sdlg), form dialog (.cc-modal), buttons and tags are the whole OS's.
  const GLOBAL = ["style.css", "os.css", "joya-ai.css", "joya-os.css", "joya-ds.css", "app.js", "voice-stop.js", "os.js", "step-up.js"];
  const assets = (opts.assets || []).filter((f) => /^[a-z0-9-]+\.(css|js)$/.test(f) && !GLOBAL.includes(f));
  const css = assets.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="${asset(f)}">`).join("\n");
  const js = assets.filter((f) => f.endsWith(".js")).map((f) => `<script src="${asset(f)}" defer></script>`).join("\n");
  // The theme is applied before first paint, so a dark page never flashes
  // light. A blocking external script because the CSP forbids inline ones.
  const theme = `<script src="${asset("theme-init.js")}"></script>\n`;
  const cls = opts.pageClass && /^[a-z0-9 -]+$/.test(opts.pageClass) ? ` class="${opts.pageClass}"` : "";
  // The AI's own pages (the Command Center) carry the JOYA AI title; every page,
  // theirs included, carries the one Joya icon (see iconLinks).
  const ai = opts.brand === "ai";
  return `<!doctype html>
<html lang="en"${cls}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ai && title === "JOYA AI" ? "JOYA AI" : `${esc(title)} — ${ai ? "JOYA AI" : "Joya"}`}</title>
${iconLinks()}
<link rel="preload" href="/static/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2?v=5.3.0" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/atkinson-hyperlegible-next-latin-700-normal.woff2?v=5.3.0" as="font" type="font/woff2" crossorigin>
${theme}<link rel="stylesheet" href="${asset("style.css")}">
<link rel="stylesheet" href="${asset("os.css")}">
<link rel="stylesheet" href="${asset("joya-ai.css")}">
${css}
<link rel="stylesheet" href="${asset("joya-os.css")}">
<link rel="stylesheet" href="${asset("joya-ds.css")}">
<script src="${asset("app.js")}" defer></script>
<script src="${asset("voice-stop.js")}" defer></script>
<script src="${asset("os.js")}" defer></script>
<script src="${asset("step-up.js")}" defer></script>
${js}
</head><body${require("./signin").passwordOnly ? ' data-signin="password"' : ""}>
${inner}
</body></html>`;
}

/* ------------------------------------------------------------ components - */

/**
 * Permission check for a view, given the viewer context it was handed.
 *
 * Views use this to hide buttons; routes enforce the same permission again
 * before acting. Hiding a control is a courtesy, not a boundary -- the boundary
 * is the guard on the route, and it is checked whether or not the button was
 * ever rendered. A missing context (the setup pages) allows everything, because
 * there is no actor to restrict yet.
 */
function can(user, perm, scopeSlug) {
  const p = user && typeof user === "object" ? user.perm : null;
  if (!p) return true;
  if (scopeSlug === undefined) return p.can(perm);
  return perm.startsWith("channels.")
    ? p.canChannel(perm, scopeSlug)
    : p.canAgent(perm, scopeSlug);
}

/**
 * Step indicator for the two-part agent creation flow.
 *
 * The two steps are the two existing forms, not a new combined one. Creating an
 * agent and connecting a channel are separately useful -- you add a second
 * channel to an existing agent, or rebuild a channel without touching the
 * agent's memory -- so the wizard chains the real pages rather than replacing
 * them with a bespoke path that would then have to be maintained twice.
 */
function steps(current, items) {
  return `<ol class="wizard">
    ${items
      .map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "on" : "";
        return `<li class="wizard-step ${state}">
          <span class="wizard-num">${n < current ? icon("check", 14) : n}</span>
          <span>${esc(label)}</span>
        </li>`;
      })
      .join("")}
  </ol>`;
}

/*
 * A state as a word and a shape, never colour alone (DESIGN.md): a filled dot
 * for ok, a triangle for failed, a half dot for in between, a hollow ring for
 * off. `tone` is ok | bad | warn | off | info; the word is what it says.
 */
const SHAPES = {
  ok: '<circle cx="8" cy="8" r="5"/>',
  bad: '<path d="M8 2.5 14 13H2Z"/>',
  warn: '<path d="M8 3a5 5 0 0 1 0 10Z"/><circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>',
  info: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>',
  off: '<circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>',
};
function state(tone, word, title) {
  const t = SHAPES[tone] ? tone : "off";
  return `<span class="state ${t}"${title ? ` title="${esc(title)}"` : ""}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" stroke="currentColor">${SHAPES[t]}</svg>${esc(word)}</span>`;
}

/** A service's state (systemd ActiveState) as a word and a shape. */
function statusPill(st) {
  return st === "active" ? state("ok", "Running", "systemd: active") : state("bad", st || "unknown", "systemd: " + (st || "unknown"));
}

const AGENT_STATES = {
  active: ["ok", "Running"],
  activating: ["warn", "Starting"],
  deactivating: ["warn", "Stopping"],
  failed: ["bad", "Failed"],
  inactive: ["off", "Stopped"],
};
function agentPill(st) {
  const [tone, word] = AGENT_STATES[st] || ["off", st || "Unknown"];
  return state(tone, word, "systemd: " + (st || "unknown"));
}

function meter(name, label, used, total) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  const level = pct > 90 ? "bad" : pct > 75 ? "warn" : "ok";
  return `<div class="meter" data-meter="${esc(name)}">
    <div class="meter-head"><span>${esc(label)}</span>
      <span class="muted">${bytes(used)} / ${bytes(total)}</span></div>
    <div class="bar"><div class="fill ${level}" data-w="${pct}"></div></div>
  </div>`;
}

/** A figure and its label, plain (2026-10-25: no icon disc). `iconName` is kept for the callers and ignored. */
// eslint-disable-next-line no-unused-vars
function stat(value, label, iconName) {
  return `<div class="statbox">
    <span class="statbox-value">${esc(String(value))}</span>
    <span class="statbox-label">${esc(label)}</span>
  </div>`;
}

function card(title, body, opts = {}) {
  return `<section class="card${opts.className ? " " + opts.className : ""}"${opts.id ? ` id="${esc(opts.id)}"` : ""}>
    ${
      title
        ? `<div class="card-head"><h2>${
            opts.icon ? icon(opts.icon) : ""
          }${esc(title)}</h2>${opts.actions || ""}</div>`
        : ""
    }
    ${opts.bodyClass ? `<div class="${esc(opts.bodyClass)}">${body}</div>` : body}
  </section>`;
}

/**
 * A document page with a sticky side column (pattern C): the main column
 * scrolls with the page, the side stays in view.
 */
function docLayout(main, side) {
  return `<div class="doc-grid"><div class="doc-main">${main}</div><aside class="doc-side">${side}</aside></div>`;
}

/** "On this page": links to the sections of a document, highlighted by os.js. */
function tocCard(items, title) {
  if (!items.length) return "";
  return `<section class="card"><div class="card-head"><h2>${esc(title || "On this page")}</h2></div>
    <ul class="toc-list" data-toc>${items
      .map(([id, label], i) => `<li><a href="#${esc(id)}"${i === 0 ? ' class="on"' : ""}>${esc(label)}</a></li>`)
      .join("")}</ul></section>`;
}

function flashes({ msg, err }) {
  let out = "";
  if (msg) out += `<div class="alert good">${icon("check")}<div>${esc(msg)}</div></div>`;
  if (err) out += `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>`;
  return out;
}

/**
 * How to enrol, worded for Microsoft Authenticator.
 *
 * The app files a panel like this one under "Other account", not under its
 * "Work or school account" flow -- that one signs in to Entra and will not
 * accept this QR code. Somebody who taps the wrong entry gets an error that
 * explains nothing, so the path is spelled out rather than left to be found.
 *
 * Shared by first-run setup, admin enrolment and the move-app flow, because
 * three copies of an instruction is three chances for one of them to go stale.
 */
function enrolSteps(account) {
  return `<ol class="steps">
    <li>Open <strong>Microsoft Authenticator</strong> on your phone.</li>
    <li>Tap <strong>+</strong>, then <strong>Other account (Google, Facebook, etc.)</strong>
      — not "Work or school account".</li>
    <li>Scan the code${
      account ? ` — it is saved as <span class="mono">${esc(account)}</span>` : ""
    }.</li>
  </ol>
  <p class="muted small">Any other authenticator works the same way. This is standard
    RFC 6238, so Authy, 1Password and Google Authenticator all read the same code.</p>`;
}

function empty(iconName, title, body) {
  return `<div class="empty">
    <span class="empty-ico">${icon(iconName, 28)}</span>
    <p class="empty-title">${esc(title)}</p>
    <p class="muted">${body}</p>
  </div>`;
}

module.exports = {
  dockMarkup,
  iconLinks,
  appIcons,
  appIconSet,
  ICON_SETS,
  FAVICON,
  manifest,
  MANIFEST_VERSION,
  pageMapFor,
  asset,
  docLayout,
  tocCard,
  esc,
  bytes,
  duration,
  ago,
  stamp,
  shell,
  page,
  statusPill,
  state,
  agentPill,
  meter,
  stat,
  card,
  flashes,
  empty,
  enrolSteps,
  icon,
  can,
  steps,
  NAV,
  ALIASES,
  locate,
  allowed,
  badgeHtml,
};
