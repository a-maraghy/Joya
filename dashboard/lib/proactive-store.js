"use strict";
/**
 * Proactive JOYA AI's rows, in the panel database (joya.db), in tables of its
 * own -- created here, never touching another table, so the change is additive:
 *
 *   proactive_prefs     one row per person: the brief (on, time, days, time
 *                       zone, read aloud), the catch-up (on, away minutes), and
 *                       when they were last seen / last briefed
 *   proactive_watchers  their watchers (kind, params JSON, repeat, quiet time,
 *                       paused, done, the check's state JSON, how often fired)
 *   proactive_inbox     what was written for them: briefs, catch-ups and watcher
 *                       alerts (title, body JSON), read / dismissed
 *   proactive_events    what the clock saw the sessions do (started, finished,
 *                       working, waiting, ended), the brief's history; pruned
 *                       after 14 days
 *
 *   create(db)  db: a better-sqlite3 handle (lib/db.js exports it as .db)
 */

const P = require("./proactive");

const PREF_DEFAULTS = Object.freeze({
  brief_on: 1,
  brief_time: "08:00",
  brief_days: "0,1,2,3,4,5,6",
  tz: "",
  read_aloud: 0,
  catchup_on: 1,
  away_min: 30,
});
const AWAY_MIN = [10, 240];
const EVENT_KEEP_MS = 14 * 86400e3;
const INBOX_KEEP_MS = 30 * 86400e3;

function create(db, opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const iso = (ms) => new Date(ms == null ? now() : ms).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_prefs (
      user_id      INTEGER PRIMARY KEY,
      brief_on     INTEGER NOT NULL DEFAULT 1,
      brief_time   TEXT NOT NULL DEFAULT '08:00',
      brief_days   TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
      tz           TEXT NOT NULL DEFAULT '',
      read_aloud   INTEGER NOT NULL DEFAULT 0,
      catchup_on   INTEGER NOT NULL DEFAULT 1,
      away_min     INTEGER NOT NULL DEFAULT 30,
      last_brief_day TEXT,
      last_brief_at  TEXT,
      last_seen_at   TEXT,
      seen_usd       REAL,
      seen_day       TEXT,
      updated_at   TEXT,
      updated_by   TEXT
    );
    CREATE TABLE IF NOT EXISTS proactive_watchers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      params       TEXT NOT NULL DEFAULT '{}',
      repeat       TEXT NOT NULL DEFAULT 'once',
      cooldown_min INTEGER NOT NULL DEFAULT 10,
      label        TEXT NOT NULL DEFAULT '',
      paused       INTEGER NOT NULL DEFAULT 0,
      done         INTEGER NOT NULL DEFAULT 0,
      state        TEXT NOT NULL DEFAULT '{}',
      fired_count  INTEGER NOT NULL DEFAULT 0,
      last_fired_at TEXT,
      last_text    TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_watchers_user ON proactive_watchers(user_id);
    CREATE TABLE IF NOT EXISTS proactive_inbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '{}',
      watcher_id   INTEGER,
      created_at   TEXT NOT NULL,
      read_at      TEXT,
      dismissed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS proactive_inbox_user ON proactive_inbox(user_id, id);
    CREATE TABLE IF NOT EXISTS proactive_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      kind         TEXT NOT NULL,
      session      TEXT NOT NULL DEFAULT '',
      session_key  TEXT NOT NULL DEFAULT '',
      detail       TEXT
    );
    CREATE INDEX IF NOT EXISTS proactive_events_ts ON proactive_events(ts);
  `);
  const q = (sql) => db.prepare(sql);

  function prefRow(userId) {
    const r = q("SELECT * FROM proactive_prefs WHERE user_id = ?").get(Number(userId));
    return Object.assign({ user_id: Number(userId) }, PREF_DEFAULTS, r || {});
  }
  function prefs(userId, defaultTz) {
    const r = prefRow(userId);
    return {
      user_id: r.user_id,
      brief_on: !!r.brief_on,
      brief_time: P.validHm(r.brief_time) ? r.brief_time : PREF_DEFAULTS.brief_time,
      brief_days: String(r.brief_days || "")
        .split(",")
        .map(Number)
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      tz: P.validTz(r.tz) ? r.tz : defaultTz || "UTC",
      tz_set: P.validTz(r.tz),
      read_aloud: !!r.read_aloud,
      catchup_on: !!r.catchup_on,
      away_min: Math.min(AWAY_MIN[1], Math.max(AWAY_MIN[0], Number(r.away_min) || PREF_DEFAULTS.away_min)),
      last_brief_day: r.last_brief_day || null,
      last_brief_at: r.last_brief_at || null,
      last_seen_at: r.last_seen_at || null,
      seen_usd: r.seen_usd == null ? null : Number(r.seen_usd),
      seen_day: r.seen_day || null,
    };
  }
  /** Change some of a person's settings; `p` holds only checked values. */
  function setPrefs(userId, p, by) {
    const cur = prefRow(userId);
    const v = Object.assign({}, cur, p);
    q(`INSERT INTO proactive_prefs (user_id, brief_on, brief_time, brief_days, tz, read_aloud, catchup_on, away_min, last_brief_day, last_brief_at, last_seen_at, seen_usd, seen_day, updated_at, updated_by)
       VALUES (@user_id, @brief_on, @brief_time, @brief_days, @tz, @read_aloud, @catchup_on, @away_min, @last_brief_day, @last_brief_at, @last_seen_at, @seen_usd, @seen_day, @updated_at, @updated_by)
       ON CONFLICT(user_id) DO UPDATE SET brief_on = excluded.brief_on, brief_time = excluded.brief_time, brief_days = excluded.brief_days, tz = excluded.tz,
         read_aloud = excluded.read_aloud, catchup_on = excluded.catchup_on, away_min = excluded.away_min, last_brief_day = excluded.last_brief_day,
         last_brief_at = excluded.last_brief_at, last_seen_at = excluded.last_seen_at, seen_usd = excluded.seen_usd, seen_day = excluded.seen_day,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run({
      user_id: Number(userId),
      brief_on: v.brief_on ? 1 : 0,
      brief_time: v.brief_time,
      brief_days: Array.isArray(v.brief_days) ? v.brief_days.join(",") : String(v.brief_days),
      tz: v.tz || "",
      read_aloud: v.read_aloud ? 1 : 0,
      catchup_on: v.catchup_on ? 1 : 0,
      away_min: Number(v.away_min) || PREF_DEFAULTS.away_min,
      last_brief_day: v.last_brief_day || null,
      last_brief_at: v.last_brief_at || null,
      last_seen_at: v.last_seen_at || null,
      seen_usd: v.seen_usd == null ? null : Number(v.seen_usd),
      seen_day: v.seen_day || null,
      updated_at: by === undefined ? cur.updated_at || null : iso(),
      updated_by: by === undefined ? cur.updated_by || null : by,
    });
  }

  /* ---- watchers ---- */
  function watcherRow(r) {
    if (!r) return null;
    const w = { ...r, paused: !!r.paused, done: !!r.done, params: safe(r.params, {}), state: safe(r.state, {}) };
    w.text = P.describe(w);
    return w;
  }
  const watchers = (userId) => q("SELECT * FROM proactive_watchers WHERE user_id = ? ORDER BY id").all(Number(userId)).map(watcherRow);
  const watcher = (userId, id) => watcherRow(q("SELECT * FROM proactive_watchers WHERE user_id = ? AND id = ?").get(Number(userId), Number(id)));
  const armed = () => q("SELECT * FROM proactive_watchers WHERE paused = 0 AND done = 0 ORDER BY user_id, id").all().map(watcherRow);
  const watcherCount = (userId) => q("SELECT count(*) AS n FROM proactive_watchers WHERE user_id = ?").get(Number(userId)).n;
  /** Add one (already validated). Refused past the cap: returns null. */
  const addWatcher = db.transaction((userId, v) => {
    if (watcherCount(userId) >= P.MAX_WATCHERS) return null;
    const t = iso();
    const r = q("INSERT INTO proactive_watchers (user_id, kind, params, repeat, cooldown_min, label, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)").run(Number(userId), v.kind, JSON.stringify(v.params), v.repeat, v.cooldown_min, v.label || "", t, t);
    return watcher(userId, r.lastInsertRowid);
  });
  function setPaused(userId, id, paused) {
    // Resuming a watcher that fired once arms it again, from now.
    const r = q("UPDATE proactive_watchers SET paused = ?, done = CASE WHEN ? = 0 THEN 0 ELSE done END, state = CASE WHEN ? = 0 AND done = 1 THEN '{}' ELSE state END, updated_at = ? WHERE user_id = ? AND id = ?").run(paused ? 1 : 0, paused ? 1 : 0, paused ? 1 : 0, iso(), Number(userId), Number(id));
    return r.changes ? watcher(userId, id) : null;
  }
  const deleteWatcher = (userId, id) => q("DELETE FROM proactive_watchers WHERE user_id = ? AND id = ?").run(Number(userId), Number(id)).changes > 0;
  function saveCheck(id, state, fired, done, text) {
    if (fired) q("UPDATE proactive_watchers SET state = ?, fired_count = fired_count + ?, last_fired_at = ?, last_text = ?, done = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(state), fired, iso(), text || null, done ? 1 : 0, iso(), Number(id));
    else q("UPDATE proactive_watchers SET state = ? WHERE id = ?").run(JSON.stringify(state), Number(id));
  }

  /* ---- inbox ---- */
  function inboxRow(r) {
    return r ? { ...r, body: safe(r.body, {}) } : null;
  }
  function addInbox(userId, kind, title, body, watcherId) {
    const r = q("INSERT INTO proactive_inbox (user_id, kind, title, body, watcher_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(Number(userId), kind, String(title).slice(0, 200), JSON.stringify(body || {}), watcherId || null, iso());
    return inboxRow(q("SELECT * FROM proactive_inbox WHERE id = ?").get(r.lastInsertRowid));
  }
  /** What a page shows: the watcher alerts of the last day and the newest brief and catch-up not yet dismissed. */
  function inbox(userId, afterId) {
    const since = iso(now() - 24 * 3600e3);
    const rows = q("SELECT * FROM proactive_inbox WHERE user_id = ? AND id > ? AND (kind = 'watch' AND created_at >= ? OR kind IN ('brief','catchup') AND dismissed_at IS NULL) ORDER BY id DESC LIMIT 60").all(Number(userId), Number(afterId) || 0, since).map(inboxRow);
    // One brief and one catch-up: the newest of each.
    const seen = {};
    return rows.filter((r) => (r.kind === "watch" ? true : seen[r.kind] ? false : (seen[r.kind] = true))).reverse();
  }
  const inboxItem = (userId, id) => inboxRow(q("SELECT * FROM proactive_inbox WHERE user_id = ? AND id = ?").get(Number(userId), Number(id)));
  const dismiss = (userId, id) => q("UPDATE proactive_inbox SET dismissed_at = COALESCE(dismissed_at, ?), read_at = COALESCE(read_at, ?) WHERE user_id = ? AND id = ?").run(iso(), iso(), Number(userId), Number(id)).changes > 0;
  /** A newer brief replaces an older one not dismissed (it would only repeat it). */
  const supersede = (userId, kind, keepId) => q("UPDATE proactive_inbox SET dismissed_at = COALESCE(dismissed_at, ?) WHERE user_id = ? AND kind = ? AND id <> ? AND dismissed_at IS NULL").run(iso(), Number(userId), kind, Number(keepId)).changes;
  const fires = (userId, fromMs, toMs) => q("SELECT * FROM proactive_inbox WHERE user_id = ? AND kind = 'watch' AND created_at > ? AND created_at <= ? ORDER BY id").all(Number(userId), iso(fromMs), iso(toMs)).map((r) => ({ text: (safe(r.body, {}).text) || r.title, at: r.created_at }));
  const lastOf = (userId, kind) => inboxRow(q("SELECT * FROM proactive_inbox WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(Number(userId), kind));

  /* ---- events ---- */
  const addEvent = (e) => q("INSERT INTO proactive_events (ts, kind, session, session_key, detail) VALUES (?, ?, ?, ?, ?)").run(iso(e.at), e.kind, String(e.name || "").slice(0, 120), String(e.key || "").slice(0, 80), e.ms != null || e.for ? JSON.stringify({ ms: e.ms != null ? e.ms : undefined, for: e.for || undefined }) : null);
  const events = (fromMs, toMs) => q("SELECT * FROM proactive_events WHERE ts > ? AND ts <= ? ORDER BY id").all(iso(fromMs), iso(toMs));
  function prune() {
    q("DELETE FROM proactive_events WHERE ts < ?").run(iso(now() - EVENT_KEEP_MS));
    q("DELETE FROM proactive_inbox WHERE created_at < ?").run(iso(now() - INBOX_KEEP_MS));
  }

  return { prefs, setPrefs, watchers, watcher, armed, watcherCount, addWatcher, setPaused, deleteWatcher, saveCheck, addInbox, inbox, inboxItem, dismiss, supersede, fires, lastOf, addEvent, events, prune, PREF_DEFAULTS, AWAY_MIN };
}

function safe(s, d) {
  try {
    const v = JSON.parse(s);
    return v == null ? d : v;
  } catch (_) {
    return d;
  }
}

module.exports = { create, PREF_DEFAULTS, AWAY_MIN };
