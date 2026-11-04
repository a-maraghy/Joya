"use strict";
/**
 * The page map at run time: the registry (lib/page-registry.js) as last
 * scanned, the allow switches, and who has been told.
 *
 * Stored in the panel's settings (never the supervisor's ledger):
 *   ui_page_registry  { at, by, entries, diff, new_keys }  the last scan
 *   ui_page_allow     { key: false, ... }                   switched off (missing = allowed)
 *   ui_page_policy    "auto" | "wait"                       what a new entry starts as
 *
 * The allowed entries (effective()) are what JOYA AI may open: they are set
 * in this process's ui-actions (the relay validates page.open with it), given
 * to each page (data-page-map, checked again there, with the viewer's role),
 * and pushed to the supervisor (op ui-pages) for ui_actions_list and ui_do.
 * A push that fails (JOYA AI down) is retried until it lands.
 */

const Registry = require("./page-registry");
const UiActions = require("../public/ui-actions.js");

const K_REG = "ui_page_registry";
const K_ALLOW = "ui_page_allow";
const K_POLICY = "ui_page_policy";

let deps = null; // { db, joyaai }
let state = null; // { at, by, entries, diff, new_keys }
let pushTimer = null;
let lastPush = { ok: null, at: null, error: null };

function readJson(key, fallback) {
  try {
    const v = deps.db.getSetting(key, "");
    return v ? JSON.parse(v) : fallback;
  } catch (_) {
    return fallback;
  }
}
function writeJson(key, value, by) {
  deps.db.setSetting(key, JSON.stringify(value), by || "panel");
}

function policy() {
  try {
    return deps.db.getSetting(K_POLICY, "auto") === "wait" ? "wait" : "auto";
  } catch (_) {
    return "auto";
  }
}
function allowMap() {
  const a = readJson(K_ALLOW, {});
  return a && typeof a === "object" ? a : {};
}

/**
 * Scan the sources and store the result. The diff is against the last stored
 * scan (or, the first time, page.open's old fixed keys). New entries take the
 * New entries policy: allowed at once, or off until allowed.
 */
function scan(by) {
  const prev = readJson(K_REG, null);
  const entries = Registry.build();
  const diff = Registry.diff(prev && Array.isArray(prev.entries) ? prev.entries : null, entries);
  const changed = !prev || diff.added.length || diff.renamed.length || diff.removed.length;
  if (policy() === "wait" && diff.added.length) {
    const a = allowMap();
    for (const k of diff.added) if (a[k] === undefined) a[k] = false;
    writeJson(K_ALLOW, a, by);
  }
  state = {
    at: changed || !prev ? new Date().toISOString() : prev.at,
    by: changed || !prev ? by || "panel start" : prev.by,
    entries,
    diff: changed ? diff : prev.diff || diff,
    new_keys: changed ? diff.added : prev.new_keys || [],
    scanned_at: new Date().toISOString(),
  };
  if (changed || !prev) writeJson(K_REG, { at: state.at, by: state.by, entries, diff: state.diff, new_keys: state.new_keys }, by);
  apply();
  return state;
}

/** The allowed entries, in order. */
function effective() {
  if (!state) return null;
  return Registry.effective(state.entries, allowMap());
}

/** Tell this process's ui-actions and the supervisor. */
function apply() {
  const list = effective();
  if (!list) return;
  UiActions.setPages(list);
  push();
}

function push() {
  if (!deps || !deps.joyaai) return;
  clearTimeout(pushTimer);
  const list = (effective() || []).map((e) => ({ key: e.key, parent: e.parent, kind: e.kind, label: e.label, url: e.url, perm: e.perm }));
  deps.joyaai
    .call("ui-pages", { pages: list }, "joya-os")
    .then((r) => {
      lastPush = { ok: true, at: new Date().toISOString(), error: null, applied: !!(r && r.applied) };
    })
    .catch((e) => {
      lastPush = { ok: false, at: new Date().toISOString(), error: e.message };
      pushTimer = setTimeout(push, 60000);
      if (pushTimer.unref) pushTimer.unref();
    });
}

function setAllow(key, on, by) {
  const a = allowMap();
  if (on) delete a[key];
  else a[key] = false;
  writeJson(K_ALLOW, a, by);
  apply();
}
function allowAll(by) {
  writeJson(K_ALLOW, {}, by);
  apply();
}
function setPolicy(p, by) {
  deps.db.setSetting(K_POLICY, p === "wait" ? "wait" : "auto", by || "panel");
}

/** For a page: the keys this viewer may open and the map to check them against. */
function forViewer(perm) {
  const list = effective() || [];
  const can = (p) => !p || !perm || perm.can(p);
  return {
    keys: list.filter((e) => can(e.perm)).map((e) => e.key),
    map: list.map((e) => ({ key: e.key, url: e.url, label: e.label, perm: e.perm, kind: e.kind })),
  };
}

function configure(d) {
  deps = d;
  state = null;
}

module.exports = {
  configure,
  scan,
  effective,
  current: () => state,
  allowMap,
  policy,
  setAllow,
  allowAll,
  setPolicy,
  forViewer,
  lastPush: () => lastPush,
  K_REG,
  K_ALLOW,
  K_POLICY,
};
