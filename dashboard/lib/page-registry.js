"use strict";
/**
 * The page map: every place in Joya that JOYA AI's page.open may take the
 * administrator to, built from the source rather than kept by hand.
 *
 *   entries = [{ key, parent, kind: page|section|sheet|tab|anchor, label, url, perm }]
 *
 * Built from, in order:
 *   1. pages      ui.NAV (every sidebar item) plus the avatar menu's Account
 *   2. sections   JOYA AI Settings' sections (views-settings.js SETTINGS_SECTIONS)
 *   3. sheets     the Command Center's sheets (public/cc-logic.js SHEETS), /joya-ai#<sheet>
 *   4. tabs       the tabs a view exports (Sessions, Memory, Services), <url>?<param>=<tab>
 *   5. anchors    a static scan of lib/views-*.js (and routes-settings.js) for the
 *                 ids of cards, rows and <section>s, under the page ANCHOR_HOMES
 *                 names for that file and id prefix; the label is the card's or
 *                 row's title. An id starting "x-" is private and never listed.
 *
 * It is built when the panel starts (a deploy restarts it) and again on
 * Settings ▸ Screen control ▸ Rescan pages, which re-reads the view sources on
 * disk. Each build is compared with the last stored one (diff: new, renamed,
 * removed); the first compares with the 21 fixed keys page.open had before the
 * map existed (LEGACY_KEYS), so those show as renamed rather than lost.
 *
 * Nothing here decides who may open what: an entry's perm is checked by the
 * page before it moves (as before), and the allow switches (Settings) decide
 * which entries JOYA AI is given at all (effective()).
 */

const fs = require("fs");
const path = require("path");

const LIB = __dirname;

/** Registry keys for the sidebar's item keys (ui.NAV), and the labels JOYA AI hears. */
const PAGE_KEYS = {
  "joya-ai": ["cc", "Command Center"],
  "joya-settings": ["settings", "JOYA AI Settings"],
  machines: ["computers", "Computers"],
  "agents-dashboard": ["agents", "Agents overview"],
  "claude-sessions": ["sessions", "Sessions"],
  agents: ["telegram", "Telegram agents"],
  channels: ["channels", "Channels"],
  addons: ["addons", "Add-ons"],
  "claude-memory": ["memory", "Memory"],
  os: ["os", "Machine health"],
  services: ["services", "Services"],
  audit: ["audit", "Audit log"],
  users: ["users", "Users"],
  roles: ["roles", "Roles"],
  devices: ["devices", "Signed-in devices"],
  keys: ["keys", "SSH keys"],
  firewall: ["firewall", "Firewall"],
  credentials: ["credentials", "Credentials"],
  guide: ["guide", "Guide"],
};

/**
 * The perm an entry carries (checked by the page before it moves). A sidebar
 * item shown by a test of several permissions names the one most roles need.
 */
const PAGE_PERMS = {
  agents: "agents.view",
  sessions: "claude.sessions.view",
  services: "services.view",
};

/**
 * Where the ids found in each file belong: { file: [[id prefix, parent key], ...] }.
 * The first matching prefix wins; "" matches any id; a third element names the
 * only tag the id may sit on. An id no rule matches is not an anchor (a form's,
 * a modal's, a script hook's).
 */
const ANCHOR_HOMES = {
  "routes-settings.js": [
    ["g-", "settings.general"],
    ["a-", "settings.appearance"],
    ["s-", "settings.sessions"],
    ["sc-", "settings.screen"],
    ["p-", "settings.approvals"],
    ["u-", "settings.usage"],
  ],
  "views-settings-voice.js": [["v-", "settings.voice"]],
  "routes-chatgpt.js": [["gpt-", "settings.chatgpt"]],
  "views-agents.js": [["a-", "agents"]],
  "views-claude.js": [["s-", "sessions"]],
  "views-guide.js": [["", "guide", "section"]], // only the Guide's <section>s, not its search box
  "views.js": [["pair", "keys"]],
};

/**
 * page.open's fixed keys before the page map (public/ui-actions.js NAV_PAGES
 * until 2026-09-30) and where each went. ui-actions.js keeps the same map as
 * aliases, so an old key still opens the right page.
 */
const LEGACY_KEYS = {
  "os-overview": "os",
  agents: "agents",
  "agents-fleet": "telegram",
  "agents-channels": "channels",
  "agents-addons": "addons",
  "agents-services": "services.agents",
  "os-services": "services",
  "os-audit": "audit",
  "os-firewall": "firewall",
  "manage-credentials": "credentials",
  "manage-ssh-keys": "keys",
  "manage-devices": "devices",
  "manage-users": "users",
  "manage-roles": "roles",
  "claude-memory": "memory",
  "claude-sessions": "sessions",
  "claude-running": "sessions.live",
  guide: "guide",
  account: "account",
  "voice-settings": "settings.voice",
  "command-center": "cc",
};

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Visible text of a bit of template source: tags and ${...} out, entities in. */
function textOf(src) {
  return String(src || "")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * The anchors of one view source: [{ id, label, tag }] (tag: the HTML tag an id="" sits on). An id in an HTML tag
 * (id="…") takes the first <h2>/<h3> after it; an id in a call's options
 * ({ id: "…" }) takes the title of the nearest card( / row( / group( before it.
 */
function scanAnchors(src) {
  const out = [];
  const seen = new Set();
  const re = /\bid(?:="([a-z][a-z0-9-]{1,40})"|:\s*"([a-z][a-z0-9-]{1,40})")/g;
  let m;
  while ((m = re.exec(src))) {
    const id = m[1] || m[2];
    if (seen.has(id)) continue;
    const open = src.lastIndexOf("<", m.index);
    const tag = m[1] && open >= 0 && src.indexOf(">", open) >= m.index ? (/^<([a-z0-9]+)/.exec(src.slice(open, open + 12)) || [])[1] || "" : "";
    let label = "";
    if (m[1]) {
      const after = src.slice(m.index, m.index + 600);
      const h = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/.exec(after);
      if (h) label = textOf(h[1]);
    } else {
      const before = src.slice(Math.max(0, m.index - 4000), m.index);
      const calls = [...before.matchAll(/\b(?:card|row|group)\(\s*"([^"]{1,120})"/g)];
      if (calls.length) label = calls[calls.length - 1][1].replace(/&amp;/g, "&");
    }
    if (!label) continue;
    seen.add(id);
    out.push({ id, label, tag });
  }
  return out;
}

/**
 * Build the registry from the sources on disk.
 * @param o { nav, sections, sheets, tabs, libDir } (all optional: defaults read the real modules)
 */
function build(o = {}) {
  const nav = o.nav || require("./ui").NAV;
  const sections = o.sections || require("./views-settings").SETTINGS_SECTIONS;
  const sheets = o.sheets || require("../public/cc-logic").SHEETS;
  const tabs = o.tabs || defaultTabs();
  const libDir = o.libDir || LIB;
  const out = [];
  const keys = new Set();
  const add = (e) => {
    if (!KEY_RE.test(e.key) || keys.has(e.key)) return;
    keys.add(e.key);
    out.push({ key: e.key, parent: e.parent || null, kind: e.kind, label: String(e.label).slice(0, 120), url: e.url, perm: e.perm || null });
  };

  // 1. pages
  for (const g of nav) {
    for (const it of g.items) {
      const [key, label] = PAGE_KEYS[it.key] || [slug(it.key), it.label];
      add({ key, kind: "page", label, url: it.href, perm: PAGE_PERMS[key] || it.perm || null });
    }
  }
  add({ key: "account", kind: "page", label: "Your account", url: "/account", perm: null });
  // The Guide sits in the avatar menu since 2026-10-25 (no longer a sidebar item).
  add({ key: "guide", kind: "page", label: "Guide", url: "/guide", perm: null });

  // 2. JOYA AI Settings' sections
  for (const [k, label] of sections) add({ key: "settings." + k, parent: "settings", kind: "section", label, url: "/joya-ai/settings/" + k, perm: k === "voice" ? "voice.manage" : "joyaai.use" });

  // 3. the Command Center's sheets
  for (const s of sheets) if (s && s.key) add({ key: "cc." + s.key, parent: "cc", kind: "sheet", label: s.label, url: "/joya-ai#" + s.key, perm: "joyaai.use" });

  // 4. tabs
  for (const t of tabs) add({ key: t.parent + "." + t.key, parent: t.parent, kind: "tab", label: t.label, url: t.url, perm: t.perm || null });

  // 5. anchors
  const pageOf = new Map(out.map((e) => [e.key, e]));
  for (const file of Object.keys(ANCHOR_HOMES).sort()) {
    let src = "";
    try {
      src = fs.readFileSync(path.join(libDir, file), "utf8");
    } catch (_) {
      continue; // a view that is not in this build
    }
    for (const a of scanAnchors(src)) {
      if (a.id.startsWith("x-")) continue;
      const rule = ANCHOR_HOMES[file].find(([p, , tag]) => a.id.startsWith(p) && (!tag || a.tag === tag));
      if (!rule) continue;
      const parent = pageOf.get(rule[1]);
      if (!parent) continue;
      const rest = rule[0] && a.id.length > rule[0].length && rule[0].endsWith("-") ? a.id.slice(rule[0].length) : a.id;
      const base = parent.url.split("#")[0];
      add({ key: parent.key + "." + rest, parent: parent.key, kind: "anchor", label: a.label, url: base + "#" + a.id, perm: parent.perm });
    }
  }
  // Settings > Voice > Compare voices opens its own page.
  return out;
}

function defaultTabs() {
  const out = [];
  try {
    for (const [key, label, perm] of require("./views-claude").SESSION_TABS) out.push({ parent: "sessions", key, label, url: "/claude/sessions?tab=" + key, perm });
  } catch (_) {
    /* no tabs */
  }
  try {
    for (const [key, label] of require("./views-claude").MEMORY_VIEWS)
      out.push({ parent: "memory", key, label, url: "/claude/memory?view=" + key, perm: "claude.memory.read" });
  } catch (_) {
    /* no tabs */
  }
  try {
    for (const [key, label, perm] of require("./views-services").SERVICE_TABS) out.push({ parent: "services", key, label, url: "/services?kind=" + key, perm });
  } catch (_) {
    /* no tabs */
  }
  return out;
}

/**
 * Compare two builds. `prev` is the last stored list (or null: the first scan,
 * compared with LEGACY_KEYS). Returns { added:[key], renamed:[[old, from, to]], removed:[[key, why]] }.
 */
function diff(prev, next) {
  const now = new Map(next.map((e) => [e.key, e]));
  const d = { added: [], renamed: [], removed: [] };
  if (!prev) {
    const mapped = new Set();
    for (const [old, to] of Object.entries(LEGACY_KEYS)) {
      const e = now.get(to);
      if (!e) {
        d.removed.push([old, "no longer a page"]);
        continue;
      }
      mapped.add(to);
      if (old !== to) d.renamed.push([old, old, e.label + " (" + to + ")"]);
    }
    for (const e of next) if (!mapped.has(e.key)) d.added.push(e.key);
    return d;
  }
  const before = new Map(prev.map((e) => [e.key, e]));
  const byUrl = new Map(prev.map((e) => [e.url, e]));
  const renamedFrom = new Set();
  for (const e of next) {
    const was = before.get(e.key);
    if (was) {
      if (was.url !== e.url) d.renamed.push([e.key, was.url, e.url]);
      else if (was.label !== e.label) d.renamed.push([e.key, was.label, e.label]);
      continue;
    }
    const same = byUrl.get(e.url);
    if (same && !now.has(same.key)) {
      d.renamed.push([same.key, same.key, e.key]);
      renamedFrom.add(same.key);
      continue;
    }
    d.added.push(e.key);
  }
  for (const e of prev) if (!now.has(e.key) && !renamedFrom.has(e.key)) d.removed.push([e.key, "gone from the source"]);
  return d;
}

/**
 * The entries JOYA AI is given: those allowed, under parents that are
 * allowed. `allow` is { key: bool } (a missing key is allowed).
 */
function effective(entries, allow) {
  const a = allow || {};
  const by = new Map(entries.map((e) => [e.key, e]));
  const ok = (e, depth) => {
    if (!e || depth > 8) return false;
    if (a[e.key] === false) return false;
    return e.parent ? ok(by.get(e.parent), depth + 1) : true;
  };
  return entries.filter((e) => ok(e, 0));
}

module.exports = { build, diff, effective, scanAnchors, LEGACY_KEYS, PAGE_KEYS, ANCHOR_HOMES };
