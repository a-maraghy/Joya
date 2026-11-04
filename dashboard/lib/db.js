"use strict";
/**
 * SQLite state: users and roles, pairing codes, and a login log.
 *
 * The panel began single-user, with one row in an `admin` table. That table is
 * still read once, at first boot after this upgrade, to carry the existing
 * account into `users` as an administrator -- nobody should have to re-enrol
 * their authenticator because the schema grew.
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const rbac = require("./rbac");

const DATA_DIR = process.env.JOYA_DATA_DIR || "/var/lib/joya-dashboard";
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "joya.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// This file holds every password hash and every TOTP secret on the panel, and
// it was created world-readable. The directory is 0750, so this is the second
// lock rather than the first, but a database of credentials has no business
// being readable by any account that happens to be on the machine. WAL means
// two sidecars carry the same rows until a checkpoint, so they get it too.
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.chmodSync(DB_PATH + suffix, 0o600);
  } catch (_) {
    /* not every sidecar exists at every moment; the next start catches it */
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT NOT NULL,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    builtin       INTEGER NOT NULL DEFAULT 0,
    permissions   TEXT NOT NULL DEFAULT '[]',
    agent_scope   TEXT NOT NULL DEFAULT '*',
    channel_scope TEXT NOT NULL DEFAULT '*',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL DEFAULT '',
    -- The person's email address. It is what the authenticator app shows next
    -- to the code, so a phone holding entries for several systems can tell
    -- which one this is. Not UNIQUE at the schema level: an empty string is the
    -- migration state for accounts that predate the column, and several of
    -- those may exist at once. Uniqueness of real addresses is enforced above.
    email          TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    totp_secret    TEXT NOT NULL,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    role_id        INTEGER NOT NULL REFERENCES roles(id),
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    created_by     TEXT,
    last_login_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS pairing_codes (
    code        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    target_user TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    used_by_fp  TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    target_user TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    paired_at   TEXT NOT NULL,
    paired_ip   TEXT
  );

  -- The panel's own chats with Claude Code. One row per conversation; the
  -- uuid column is Claude's own session id, which is what --resume takes, so
  -- the CLI keeps the real history and this table keeps what to show and how
  -- the session is configured.
  CREATE TABLE IF NOT EXISTS console_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL UNIQUE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New chat',
    model       TEXT NOT NULL DEFAULT 'claude-opus-5',
    effort      TEXT NOT NULL DEFAULT 'medium',
    access      TEXT NOT NULL DEFAULT 'full',
    permission_mode TEXT NOT NULL DEFAULT 'auto',
    cwd         TEXT NOT NULL DEFAULT '/',
    started     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS console_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES console_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    meta        TEXT,
    ts          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS console_messages_session
    ON console_messages(session_id, id);

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );

  -- What the voice cost, one row per priced OpenAI call (lib/voice-usage.js).
  CREATE TABLE IF NOT EXISTS voice_usage (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    day     TEXT NOT NULL,
    month   TEXT NOT NULL,
    vt      TEXT,
    cat     TEXT,
    part    TEXT NOT NULL,
    model   TEXT,
    usd     REAL NOT NULL,
    tokens  TEXT,
    actor   TEXT
  );
  CREATE INDEX IF NOT EXISTS voice_usage_ts ON voice_usage(ts);

  -- The voiceprint's ledger (lib/voiceprint.js): one row per turn checked, scores and
  -- verdicts only (never audio, never an embedding), for tuning the thresholds and the
  -- 7-day picture in Settings > Voice. Kept 90 days.
  CREATE TABLE IF NOT EXISTS voiceprint_checks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    actor     TEXT,
    call_id   TEXT,
    turn      INTEGER,
    mode      TEXT,
    speech_ms INTEGER,
    score     REAL,
    tts_score REAL,
    verdict   TEXT NOT NULL,
    gated     INTEGER NOT NULL DEFAULT 0,
    acted     TEXT,
    over_voice INTEGER NOT NULL DEFAULT 0,
    ms        REAL,
    error     TEXT
  );
  CREATE INDEX IF NOT EXISTS voiceprint_checks_ts ON voiceprint_checks(ts);

  CREATE TABLE IF NOT EXISTS login_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    ip         TEXT,
    username   TEXT,
    outcome    TEXT NOT NULL,
    detail     TEXT
  );
`);

const nowIso = () => new Date().toISOString();

/**
 * Add a column to a table that already exists.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there, so
 * a column added to the schema above reaches new installs and no others. This
 * is how it reaches the rest, and it is written to be safe to run every start.
 */
function addColumn(table, column, definition) {
  const has = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column).n;
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Existing installs get the column empty. The panel then asks for an address
// the next time each account is edited, and says on the users page how many are
// still missing one -- rather than inventing a value or refusing sign-in to
// people who were enrolled before the column existed.
addColumn("users", "email", "TEXT NOT NULL DEFAULT ''");

// The JOYA AI core each person chose for the Command Center: "A" (dotted
// sphere), "B" (Siri fluid), "C" (hybrid) or "D" (mesh). Empty means never
// chosen, which reads as the default -- D since 2026-10-06, C before -- in
// public/cc-logic.js normCore, so a new account gets the default without a
// value being written for it. (SQLite cannot change a column's DEFAULT in
// place; '' meaning "the default" is what makes D the default for new users.)
addColumn("users", "joya_core", "TEXT NOT NULL DEFAULT ''");
addColumn("users", "sessions_view", "TEXT NOT NULL DEFAULT ''"); // '' = spheres (the default), or "orbit"
// Core E ("Bot"): the head style ('' = "cap", public/cc-logic.js normBotHead) and the colours
// ('' = the Default preset; else JSON {p} or {p: "custom", c: {item: "#RRGGBB"}}, cc-logic.js normBotColors).
addColumn("users", "joya_bot_head", "TEXT NOT NULL DEFAULT ''");
addColumn("users", "joya_bot_colors", "TEXT NOT NULL DEFAULT ''");
addColumn("users", "joya_bot_face", "TEXT NOT NULL DEFAULT ''"); // core E's face style ('' = "smooth", cc-logic.js normBotFace)
addColumn("users", "joya_bot_team", "TEXT NOT NULL DEFAULT ''"); // core E: the heads pinned per session (cc-logic normBotTeam JSON)
// JOYA AI's sounds (2026-10-20): '' = the defaults (on, 30 %, quiet 23:00-07:00); else the JSON from
// public/joya-sound.js soundPrefsJson. A plain browser stays silent until switched on there (localStorage).
addColumn("users", "joya_sound", "TEXT NOT NULL DEFAULT ''");

// How the voice speaks to this person, learned from how they speak to it
// (lib/voice-persona.js): JSON {dialect, gender, updated_at}, empty = not known
// yet. Never free text a person typed.
addColumn("users", "voice_persona", "TEXT NOT NULL DEFAULT ''");

// The voiceprint ledger names who spoke since stored voiceprints have names (2026-10-07):
// the person's id and the name it had then.
addColumn("voiceprint_checks", "speaker_id", "TEXT");
addColumn("voiceprint_checks", "speaker", "TEXT");

addColumn("console_sessions", "permission_mode", "TEXT NOT NULL DEFAULT 'auto'");
addColumn("console_sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
// New chats start without root. The value is written explicitly by
// createConsoleSession rather than left to this default, because a database
// that already had the column keeps whatever default it was created with --
// and on an install that predates this change, that default is 1. Anything
// inserting a console session must therefore say what it means.
addColumn("console_sessions", "root_enabled", "INTEGER NOT NULL DEFAULT 0");

/* --------------------------------------------------------------- roles --- */

function roleRow(r) {
  if (!r) return null;
  let permissions = [];
  try {
    const parsed = JSON.parse(r.permissions);
    if (Array.isArray(parsed)) permissions = parsed;
  } catch (_) {
    /* a corrupt row grants nothing rather than everything */
  }
  return { ...r, permissions, builtin: !!r.builtin };
}

function seedRoles() {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO roles
       (name, label, description, builtin, permissions, agent_scope, channel_scope, created_at)
     VALUES (@name, @label, @description, @builtin, @permissions, @agent_scope, @channel_scope, @created_at)`
  );
  for (const r of rbac.SYSTEM_ROLES) {
    insert.run({ ...r, permissions: JSON.stringify(r.permissions), created_at: nowIso() });
  }
}

/**
 * Carry the pre-RBAC single admin into `users`. Runs once: afterwards `users`
 * is non-empty. The old `admin` row is left in place rather than deleted, so
 * rolling back to the previous release still finds its account.
 */
function migrateLegacyAdmin() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  if (n > 0) return;
  const legacy = db.prepare("SELECT * FROM admin WHERE id = 1").get();
  if (!legacy) return;
  const role = db.prepare("SELECT id FROM roles WHERE name = 'administrator'").get();
  db.prepare(
    `INSERT INTO users
       (username, display_name, password_hash, totp_secret, totp_confirmed,
        role_id, disabled, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'migration')`
  ).run(
    legacy.username,
    legacy.username,
    legacy.password_hash,
    legacy.totp_secret,
    legacy.totp_confirmed,
    role.id,
    legacy.created_at || nowIso()
  );
}

/**
 * Rewrite renamed permissions (rbac.RENAMED) in stored roles. Idempotent: a
 * role holding none of the old keys is left alone, so this is a no-op on every
 * start after the first. Administrator stores "*" and never needs it.
 */
function migrateRenamedPermissions() {
  const rows = db.prepare("SELECT id, permissions FROM roles").all();
  const upd = db.prepare("UPDATE roles SET permissions = ? WHERE id = ?");
  for (const r of rows) {
    let list;
    try {
      list = JSON.parse(r.permissions);
    } catch (_) {
      continue;
    }
    if (!Array.isArray(list) || !list.some((p) => Object.prototype.hasOwnProperty.call(rbac.RENAMED, p))) continue;
    // Only renames (plus what keys.pair implies); nothing unknown is dropped.
    const next = new Set(list.map((p) => rbac.RENAMED[p] || p));
    if (next.has("keys.pair")) next.add("keys.view");
    upd.run(JSON.stringify([...next].sort()), r.id);
  }
}

/**
 * Core D ("Mesh") became the default on 2026-10-06, and everyone was moved to
 * it once: every existing account's users.joya_core becomes "D", whatever it
 * was ('' or A/B/C). Recorded in settings ("migration.joya_core_d") so it never
 * runs again -- after it, a person who switches back to A, B or C keeps that.
 * One audit line per account that changed ("account": "JOYA AI core X -> D
 * (Mesh) (new default, migration)"), like a change made in Settings.
 */
const CORE_D_MIGRATION = "migration.joya_core_d";
function migrateCoreDefaultD() {
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(CORE_D_MIGRATION)) return null;
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT id, username, joya_core FROM users WHERE joya_core <> 'D'").all();
    const upd = db.prepare("UPDATE users SET joya_core = 'D' WHERE id = ?");
    const log = db.prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, 'account', ?)");
    const ts = nowIso();
    for (const r of rows) {
      upd.run(r.id);
      const was = ["A", "B", "C"].includes(r.joya_core) ? r.joya_core : "C";
      log.run(ts, null, r.username, `JOYA AI core ${was} -> D (Mesh) (new default, migration)`);
    }
    db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'migration')").run(
      CORE_D_MIGRATION,
      JSON.stringify({ moved: rows.length, at: ts }),
      ts
    );
    return rows.length;
  });
  return run();
}

/**
 * Drop retired permissions (rbac.RETIRED) from stored roles: the classic
 * chat's console.use and console.full went with its code on 2026-10-25.
 * Idempotent; each role that changed gets an audit line. Returns the count.
 */
function migrateRetiredPermissions() {
  const rows = db.prepare("SELECT id, name, permissions FROM roles").all();
  const upd = db.prepare("UPDATE roles SET permissions = ? WHERE id = ?");
  const log = db.prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, 'roles', ?)");
  let n = 0;
  for (const r of rows) {
    let list;
    try {
      list = JSON.parse(r.permissions);
    } catch (_) {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const gone = list.filter((p) => rbac.RETIRED.includes(p));
    if (!gone.length) continue;
    upd.run(JSON.stringify(list.filter((p) => !rbac.RETIRED.includes(p))), r.id);
    log.run(nowIso(), null, "migration", `role ${r.name}: removed ${gone.join(", ")} (the classic chat was removed)`);
    n++;
  }
  return n;
}

/**
 * The cores A, B and C were retired on 2026-10-25: anyone whose saved core is
 * one of them moves to E (Bot), the core the administrator uses. Runs at every
 * start (the three can no longer be chosen, so after the first run it finds
 * nobody); each account moved gets an audit line, and the last move is recorded
 * in settings ("migration.joya_core_abc_e": {moved, at}).
 */
const CORE_ABC_MIGRATION = "migration.joya_core_abc_e";
function migrateRetiredCores() {
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT id, username, joya_core FROM users WHERE joya_core IN ('A', 'B', 'C')").all();
    if (!rows.length) return 0;
    const upd = db.prepare("UPDATE users SET joya_core = 'E' WHERE id = ?");
    const log = db.prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, 'account', ?)");
    const ts = nowIso();
    for (const r of rows) {
      upd.run(r.id);
      log.run(ts, null, r.username, `JOYA AI core ${r.joya_core} -> E (Bot) (core ${r.joya_core} retired, migration)`);
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'migration') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    ).run(CORE_ABC_MIGRATION, JSON.stringify({ moved: rows.length, at: ts }), ts);
    return rows.length;
  });
  return run();
}

/**
 * The sessions view is fixed to spheres (cleanup 2026-10-25: "Classic orbit"
 * was tried twice and reverted within seconds). The control is gone from
 * Appearance; anyone still on orbit moves to spheres, with an audit line. The
 * column stays. Recorded in settings ("migration.sessions_view_spheres").
 */
const SESSVIEW_MIGRATION = "migration.sessions_view_spheres";
function migrateSessionsViewSpheres() {
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT id, username FROM users WHERE sessions_view = 'orbit'").all();
    if (!rows.length) return 0;
    const upd = db.prepare("UPDATE users SET sessions_view = 'spheres' WHERE id = ?");
    const log = db.prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, 'account', ?)");
    const ts = nowIso();
    for (const r of rows) {
      upd.run(r.id);
      log.run(ts, null, r.username, "Sessions view orbit -> spheres (Classic orbit retired, migration)");
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'migration') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    ).run(SESSVIEW_MIGRATION, JSON.stringify({ moved: rows.length, at: ts }), ts);
    return rows.length;
  });
  return run();
}

seedRoles();
migrateLegacyAdmin();
migrateRenamedPermissions();
migrateCoreDefaultD();
migrateRetiredPermissions();
migrateRetiredCores();
migrateSessionsViewSpheres();

/* --------------------------------------------------------------- users --- */

const USER_SELECT = `
  SELECT u.*, r.name AS role_name, r.label AS role_label, r.builtin AS role_builtin,
         r.permissions AS role_permissions, r.agent_scope, r.channel_scope
    FROM users u JOIN roles r ON r.id = u.role_id`;

function userRow(u) {
  if (!u) return null;
  const role = roleRow({
    id: u.role_id,
    name: u.role_name,
    label: u.role_label,
    builtin: u.role_builtin,
    permissions: u.role_permissions,
    agent_scope: u.agent_scope,
    channel_scope: u.channel_scope,
  });
  return { ...u, disabled: !!u.disabled, totp_confirmed: !!u.totp_confirmed, role };
}

module.exports = {
  migrateRetiredCores,
  migrateSessionsViewSpheres,
  migrateRetiredPermissions,
  db,
  nowIso,

  /* --- bootstrap ------------------------------------------------------- */

  userCount: () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n,

  /* --- panel settings (small switches; secrets never go here) ------------ */

  getSetting: (key, fallback = null) => {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(String(key));
    return r ? r.value : fallback;
  },
  setSetting: (key, value, by) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      )
      .run(String(key), String(value), nowIso(), by || null),
  settingRow: (key) => db.prepare("SELECT * FROM settings WHERE key = ?").get(String(key)) || null,

  /* --- voice usage (priced OpenAI calls; see lib/voice-usage.js) --------- */

  voiceUsageInsert: (r) =>
    db
      .prepare("INSERT INTO voice_usage (ts, day, month, vt, cat, part, model, usd, tokens, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.ts, r.day, r.month, r.vt, r.cat, r.part, r.model, r.usd, r.tokens, r.actor),
  voiceUsageSince: (ms) => db.prepare("SELECT ts, vt, cat, part, model, usd FROM voice_usage WHERE ts >= ? ORDER BY ts").all(Number(ms) || 0),

  /* --- the voiceprint's ledger (lib/voiceprint.js) ----------------------- */

  voiceprintCheckInsert: (r) =>
    db
      .prepare("INSERT INTO voiceprint_checks (ts, actor, call_id, turn, mode, speech_ms, score, tts_score, verdict, gated, acted, over_voice, ms, error, speaker_id, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.ts, r.actor || null, r.call_id || null, r.turn == null ? null : r.turn, r.mode || null, r.speech_ms == null ? null : Math.round(r.speech_ms), r.score == null ? null : r.score, r.tts_score == null ? null : r.tts_score, r.verdict, r.gated ? 1 : 0, r.acted || null, r.over_voice ? 1 : 0, r.ms == null ? null : r.ms, r.error || null, r.speaker_id || null, r.speaker || null),
  voiceprintChecksSince: (ms, actor) =>
    actor
      ? db.prepare("SELECT * FROM voiceprint_checks WHERE ts >= ? AND actor = ? ORDER BY ts").all(Number(ms) || 0, String(actor))
      : db.prepare("SELECT * FROM voiceprint_checks WHERE ts >= ? ORDER BY ts").all(Number(ms) || 0),
  voiceprintChecksPrune: (beforeMs) => db.prepare("DELETE FROM voiceprint_checks WHERE ts < ?").run(Number(beforeMs) || 0).changes,
  voiceprintChecksDeleteAll: () => db.prepare("DELETE FROM voiceprint_checks").run().changes,
  voiceprintChecksDelete: (actor) => db.prepare("DELETE FROM voiceprint_checks WHERE actor = ?").run(String(actor)).changes,

  /* --- the voice persona (lib/voice-persona.js) -------------------------- */

  getVoicePersona: (userId) => {
    const r = db.prepare("SELECT voice_persona FROM users WHERE id = ?").get(Number(userId));
    return r ? r.voice_persona || "" : "";
  },
  setVoicePersona: (userId, json) => db.prepare("UPDATE users SET voice_persona = ? WHERE id = ?").run(String(json || ""), Number(userId)),

  /* --- users ----------------------------------------------------------- */

  listUsers: () =>
    db.prepare(USER_SELECT + " ORDER BY u.username").all().map(userRow),

  getUser: (id) => userRow(db.prepare(USER_SELECT + " WHERE u.id = ?").get(id)),

  getUserByName: (username) =>
    userRow(db.prepare(USER_SELECT + " WHERE u.username = ?").get(username)),

  /** Case-insensitive: addresses are not case-sensitive in practice. */
  getUserByEmail: (email) =>
    userRow(
      db
        .prepare(USER_SELECT + " WHERE u.email <> '' AND lower(u.email) = lower(?)")
        .get(String(email || ""))
    ),

  /** Accounts that predate the email column, for the prompt on the users page. */
  usersMissingEmail: () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ''").get().n,

  createUser: ({ username, displayName, email, passwordHash, totpSecret, roleId, createdBy }) =>
    db
      .prepare(
        `INSERT INTO users
           (username, display_name, email, password_hash, totp_secret, totp_confirmed,
            role_id, disabled, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(
        username,
        displayName || username,
        email || "",
        passwordHash,
        totpSecret,
        roleId,
        nowIso(),
        createdBy || null
      ),

  updateUser: (id, { displayName, email, roleId, disabled }) =>
    db
      .prepare(
        "UPDATE users SET display_name = ?, email = ?, role_id = ?, disabled = ? WHERE id = ?"
      )
      .run(displayName, email || "", roleId, disabled ? 1 : 0, id),

  setUserPassword: (id, passwordHash) =>
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id),

  /** Used both at enrolment and when an admin resets a lost authenticator. */
  setUserTotp: (id, secret, confirmed) =>
    db
      .prepare("UPDATE users SET totp_secret = ?, totp_confirmed = ? WHERE id = ?")
      .run(secret, confirmed ? 1 : 0, id),

  /** The JOYA AI core this person chose (A / B / C). The caller validates it. */
  setUserJoyaCore: (id, core) =>
    db.prepare("UPDATE users SET joya_core = ? WHERE id = ?").run(String(core), id),

  /** Core E's head style this person chose (one of cc-logic BOT_HEADS). The caller validates it. */
  setUserBotHead: (id, head) =>
    db.prepare("UPDATE users SET joya_bot_head = ? WHERE id = ?").run(String(head), id),

  /** Core E's face style this person chose (one of cc-logic BOT_FACES). The caller validates it. */
  setUserBotFace: (id, face) =>
    db.prepare("UPDATE users SET joya_bot_face = ? WHERE id = ?").run(String(face), id),

  /** Core E's colours (the JSON from cc-logic botColorsJson). The caller validates them. */
  setUserBotColors: (id, json) =>
    db.prepare("UPDATE users SET joya_bot_colors = ? WHERE id = ?").run(String(json), id),

  /** JOYA AI's sounds (the JSON from joya-sound.js soundPrefsJson). The caller validates it. */
  setUserSound: (id, json) =>
    db.prepare("UPDATE users SET joya_sound = ? WHERE id = ?").run(String(json), id),

  /** Core E's per-session heads (the JSON from cc-logic botTeamJson). The caller validates it. */
  setUserBotTeam: (id, json) =>
    db.prepare("UPDATE users SET joya_bot_team = ? WHERE id = ?").run(String(json), id),

  /** The sessions view this person chose (spheres / orbit). The caller validates it. */
  setUserSessionsView: (id, view) =>
    db.prepare("UPDATE users SET sessions_view = ? WHERE id = ?").run(String(view), id),

  confirmUserTotp: (id) =>
    db.prepare("UPDATE users SET totp_confirmed = 1 WHERE id = ?").run(id),

  touchUserLogin: (id) =>
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), id),

  deleteUser: (id) => db.prepare("DELETE FROM users WHERE id = ?").run(id),

  /** How many enabled administrators remain — the last-admin guard. */
  countActiveAdmins: () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.name = 'administrator' AND u.disabled = 0`
      )
      .get().n,

  /* --- roles ----------------------------------------------------------- */

  listRoles: () =>
    db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
           FROM roles r ORDER BY r.builtin DESC, r.label`
      )
      .all()
      .map(roleRow),

  getRole: (id) => roleRow(db.prepare("SELECT * FROM roles WHERE id = ?").get(id)),

  getRoleByName: (name) => roleRow(db.prepare("SELECT * FROM roles WHERE name = ?").get(name)),

  createRole: ({ name, label, description, permissions, agentScope, channelScope }) =>
    db
      .prepare(
        `INSERT INTO roles (name, label, description, builtin, permissions,
                            agent_scope, channel_scope, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(name, label, description || "", JSON.stringify(permissions), agentScope, channelScope, nowIso()),

  updateRole: (id, { label, description, permissions, agentScope, channelScope }) =>
    db
      .prepare(
        `UPDATE roles SET label = ?, description = ?, permissions = ?,
                          agent_scope = ?, channel_scope = ?
          WHERE id = ? AND builtin = 0`
      )
      .run(label, description || "", JSON.stringify(permissions), agentScope, channelScope, id),

  deleteRole: (id) => db.prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").run(id),

  roleUserCount: (id) =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ?").get(id).n,

  /* --- pairing & devices ----------------------------------------------- */

  createPairingCode: (code, label, targetUser, expiresAt) =>
    db
      .prepare(
        `INSERT INTO pairing_codes (code, label, target_user, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(code, label, targetUser, nowIso(), expiresAt),

  getPairingCode: (code) =>
    db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code),

  consumePairingCode: (code, fingerprint) =>
    db
      .prepare("UPDATE pairing_codes SET used_at = ?, used_by_fp = ? WHERE code = ?")
      .run(nowIso(), fingerprint, code),

  listPairingCodes: () =>
    db.prepare("SELECT * FROM pairing_codes ORDER BY created_at DESC LIMIT 50").all(),

  deletePairingCode: (code) =>
    db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code),

  addDevice: (label, targetUser, fingerprint, ip) =>
    db
      .prepare(
        `INSERT INTO devices (label, target_user, fingerprint, paired_at, paired_ip)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(label, targetUser, fingerprint, nowIso(), ip),

  listDevices: () => db.prepare("SELECT * FROM devices ORDER BY paired_at DESC").all(),

  deleteDeviceByFp: (fingerprint) =>
    db.prepare("DELETE FROM devices WHERE fingerprint = ?").run(fingerprint),

  /* --- console ---------------------------------------------------------- */

  /**
   * A user's chats, newest first.
   *
   * Archived ones are a separate call rather than a flag on the rows: the
   * sidebar shows them in their own place, and asking for "the chats" should
   * not hand back a pile the caller has to sort out.
   */
  listConsoleSessions: (userId, { archived = false, limit = 200 } = {}) =>
    db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM console_messages m WHERE m.session_id = s.id) AS message_count
           FROM console_sessions s
          WHERE s.user_id = ? AND s.archived = ?
          ORDER BY s.updated_at DESC LIMIT ?`
      )
      .all(userId, archived ? 1 : 0, limit),

  countArchivedConsoleSessions: (userId) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM console_sessions WHERE user_id = ? AND archived = 1")
      .get(userId).n,

  /** Scoped by user: one administrator's chats are not another's to read. */
  getConsoleSession: (id, userId) =>
    db
      .prepare("SELECT * FROM console_sessions WHERE id = ? AND user_id = ?")
      .get(id, userId),

  createConsoleSession: ({ uuid, userId, model, effort, access, cwd }) =>
    db
      .prepare(
        `INSERT INTO console_sessions
           (uuid, user_id, title, model, effort, access, cwd, permission_mode,
            root_enabled, started, created_at, updated_at)
         VALUES (?, ?, 'New chat', ?, ?, ?, ?, 'auto', 0, 0, ?, ?)`
      )
      .run(uuid, userId, model, effort, access, cwd, nowIso(), nowIso()),

  updateConsoleSession: (id, userId, fields) => {
    const allowed = [
      "title",
      "model",
      "effort",
      "access",
      "cwd",
      "started",
      "permission_mode",
      "archived",
      "root_enabled",
    ];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(
      `UPDATE console_sessions SET ${sets}, updated_at = @updated_at
        WHERE id = @id AND user_id = @user_id`
    ).run({ ...fields, id, user_id: userId, updated_at: nowIso() });
  },

  /**
   * Record the conversation id Claude actually created.
   *
   * Kept apart from updateConsoleSession because this is not a preference: it
   * is the identity of the conversation, and the only thing --resume will
   * accept later.
   */
  setConsoleSessionUuid: (id, userId, uuid) =>
    db
      .prepare("UPDATE console_sessions SET uuid = ? WHERE id = ? AND user_id = ?")
      .run(uuid, id, userId),

  deleteConsoleSession: (id, userId) =>
    db
      .prepare("DELETE FROM console_sessions WHERE id = ? AND user_id = ?")
      .run(id, userId),

  listConsoleMessages: (sessionId, limit = 400) =>
    db
      .prepare(
        `SELECT * FROM console_messages WHERE session_id = ?
          ORDER BY id DESC LIMIT ?`
      )
      .all(sessionId, limit)
      .reverse(),

  addConsoleMessage: (sessionId, role, content, meta) =>
    db
      .prepare(
        "INSERT INTO console_messages (session_id, role, content, meta, ts) VALUES (?, ?, ?, ?, ?)"
      )
      .run(sessionId, role, content, meta ? JSON.stringify(meta) : null, nowIso()),

  /* --- log -------------------------------------------------------------- */

  logLogin: (ip, username, outcome, detail) =>
    db
      .prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, ?, ?)")
      .run(nowIso(), ip, username, outcome, detail || null),

  recentLogins: (n = 25) =>
    db.prepare("SELECT * FROM login_log ORDER BY id DESC LIMIT ?").all(n),

  /** For the Machine core's live feed: ids, times and outcomes only, oldest first. */
  loginsAfter: (afterId, n = 200, sinceTs = null) =>
    sinceTs
      ? db.prepare("SELECT id, ts, outcome FROM login_log WHERE id > ? AND ts >= ? ORDER BY id LIMIT ?").all(afterId, sinceTs, n)
      : db.prepare("SELECT id, ts, outcome FROM login_log WHERE id > ? ORDER BY id LIMIT ?").all(afterId, n),
  lastLoginId: () => (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM login_log").get() || {}).id || 0,
};
