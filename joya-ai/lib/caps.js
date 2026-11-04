"use strict";
/**
 * Token caps per session (Joya reorganisation, build spec §6) -- the pure
 * part: what a cap setting looks like, and which state a session is in. The
 * enforcement (cards, holding JOYA AI's queue, budget-pause to a hired
 * session) is in lib/features.js and supervisor.js.
 *
 * Settings (ledger `settings`):
 *   token_caps        { default: {cap, at} | null, sessions: { "<self>" | <hire slug> | <session id>: {cap, at} } }
 *   token_caps_state  { day, sessions: { key: { warned_at, paused_at, resumed_at, resumed_by } }, held: [...] }
 *                     -- today's (Cairo day) record, so a supervisor restart keeps it; a new day clears it.
 *
 * `cap` counts TOTAL tokens including cache (the "N tok today" figure,
 * features.tokensToday(sid).total). `at`: warn (a card once a day) or pause.
 * The warn line (budget.warn_pct, shared with the cost budget) is only a quiet
 * "near" state. The administrator's own sessions ("yours") are never paused.
 */

const SELF = "<self>";
const DEFAULT = "default";
const ATS = ["warn", "pause"];
const CAP_MAX = 1e12;
const KEY_RE = /^(<self>|[a-z0-9][a-z0-9-]{0,39}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_HELD = 20;

/** One {cap, at}, or null when it is not a usable cap. */
function cleanEntry(v) {
  if (!v || typeof v !== "object") return null;
  const cap = Number(v.cap);
  if (!Number.isInteger(cap) || cap < 1 || cap > CAP_MAX) return null;
  return { cap, at: ATS.includes(v.at) ? v.at : "warn" };
}

/** The stored token_caps, cleaned: unusable entries are dropped. */
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sessions = {};
  if (r.sessions && typeof r.sessions === "object") {
    for (const [k, v] of Object.entries(r.sessions)) {
      const e = cleanEntry(v);
      if (e && KEY_RE.test(k)) sessions[k] = e;
    }
  }
  return { default: cleanEntry(r.default), sessions };
}

/** Today's state record: the stored one if it is today's, else a fresh one (the day turned). */
function stateFor(raw, day) {
  if (raw && typeof raw === "object" && raw.day === day) {
    return { day, sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {}, held: Array.isArray(raw.held) ? raw.held : [] };
  }
  return { day, sessions: {}, held: [] };
}

/** Paused and not resumed today. */
function isPaused(rec) {
  return !!(rec && rec.paused_at && !rec.resumed_at);
}

/**
 * The state a session is shown in:
 *   none     no cap
 *   ok       under the warn line
 *   near     past the warn line (warn_pct of the cap), under the cap
 *   warned   past a "warn" cap (or any cap of a session that is never paused)
 *   paused   past a "pause" cap, not resumed
 *   resumed  past a "pause" cap, resumed for today
 */
function stateOf(entry, total, warnPct, rec, canPause) {
  if (!entry) return "none";
  const t = Number(total) || 0;
  if (t >= entry.cap) {
    if (entry.at === "pause" && canPause) return rec && rec.resumed_at ? "resumed" : "paused";
    return "warned";
  }
  if (isPaused(rec)) return "paused"; // until the check point releases it
  const pct = Number.isFinite(Number(warnPct)) ? Number(warnPct) : 80;
  if (t >= (entry.cap * pct) / 100) return "near";
  return "ok";
}

module.exports = { SELF, DEFAULT, ATS, CAP_MAX, KEY_RE, MAX_HELD, cleanEntry, normalize, stateFor, isPaused, stateOf };
