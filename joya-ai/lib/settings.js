"use strict";
/**
 * The ledger's `settings` table as JSON values: one row per key, with who
 * changed it and when. The supervisor's editable settings (Joya
 * reorganisation, 2026-09-30) all live here, so a restart keeps them:
 *
 *   hire_max_live, hire_per_hour, hire_perm_mode   the hire limits (lib/hire.js)
 *   approval_timeout_s                             overrides the config's
 *   token_caps, token_caps_state                   token caps per session (lib/caps.js)
 *   ui_pages                                       JOYA AI's page map (lib/ui-actions.js setPages)
 *   budget                                         the cost-budget op's {daily_usd, warn_pct}
 *
 * A value that does not parse reads as missing: the caller's default applies.
 */

function get(db, key, fallback = null) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!r || r.value == null) return fallback;
  try {
    const v = JSON.parse(r.value);
    return v === null || v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/** Store `value` (null removes the row). */
function set(db, key, value, actor) {
  if (value === null || value === undefined) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    "INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), actor || "supervisor", new Date().toISOString());
}

/** { updated_by, updated_at } of a key, or nulls. */
function meta(db, key) {
  const r = db.prepare("SELECT updated_by, updated_at FROM settings WHERE key = ?").get(key);
  return { updated_by: (r && r.updated_by) || null, updated_at: (r && r.updated_at) || null };
}

module.exports = { get, set, meta };
