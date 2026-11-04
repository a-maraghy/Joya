"use strict";
/**
 * The living canvas's rows (2026-10-20), in the panel database (joya.db), in tables of its own --
 * created here, never touching another table, so the change is additive:
 *
 *   canvas_pins    a person's pinned widgets: the widget (checked JSON, JoyaWidgets), its size, its
 *                  place in the order. At most MAX_PINS each.
 *   canvas_stats   what the board learns, per person and widget key ("chart:usage.spend",
 *                  JoyaWidgets.learnKey): how often one was offered, pinned, dismissed, opened, and
 *                  the last one of that key that was pinned (a standing tile is drawn from it).
 *   canvas_prefs   per person: the layout locked, learning on.
 *
 * The verdicts (standing / not offered) are JoyaCanvasPolicy.learn's, over these counts.
 *
 *   create(db, { now }) -> store       db: a better-sqlite3 handle (lib/db.js exports it as .db)
 */

const W = require("../public/joya-widgets");
const Policy = require("../public/joya-canvas-policy");

const MAX_PINS = 12;
const SIZES = ["s", "m", "l"];
const WHAT = { offered: "offered", pin: "pins", dismiss: "dismissals", open: "opens" };
const SOURCE_KEYS = Object.keys(W.SOURCES).concat(["payload"]);

/** A widget key as the page may send it: "<kind>:<source>", both from the catalog. */
function cleanKey(k) {
  if (typeof k !== "string" || k.length > 40) return null;
  const i = k.indexOf(":");
  if (i < 1) return null;
  const kind = k.slice(0, i), src = k.slice(i + 1);
  return Object.prototype.hasOwnProperty.call(W.KINDS, kind) && SOURCE_KEYS.includes(src) ? k : null;
}

function create(db, opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_pins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      key         TEXT NOT NULL,
      spec        TEXT NOT NULL,
      size        TEXT NOT NULL DEFAULT 'm',
      pos         INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS canvas_pins_user ON canvas_pins(user_id);
    CREATE TABLE IF NOT EXISTS canvas_stats (
      user_id     INTEGER NOT NULL,
      key         TEXT NOT NULL,
      offered     INTEGER NOT NULL DEFAULT 0,
      pins        INTEGER NOT NULL DEFAULT 0,
      dismissals  INTEGER NOT NULL DEFAULT 0,
      opens       INTEGER NOT NULL DEFAULT 0,
      last_spec   TEXT,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS canvas_prefs (
      user_id     INTEGER PRIMARY KEY,
      locked      INTEGER NOT NULL DEFAULT 0,
      learn       INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL
    );
  `);

  const q = {
    pins: db.prepare("SELECT id, key, spec, size, pos, created_at FROM canvas_pins WHERE user_id = ? ORDER BY pos, id"),
    pinCount: db.prepare("SELECT COUNT(*) AS n FROM canvas_pins WHERE user_id = ?"),
    maxPos: db.prepare("SELECT COALESCE(MAX(pos), 0) AS p FROM canvas_pins WHERE user_id = ?"),
    addPin: db.prepare("INSERT INTO canvas_pins (user_id, key, spec, size, pos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    getPin: db.prepare("SELECT id, key, spec, size, pos, created_at FROM canvas_pins WHERE user_id = ? AND id = ?"),
    delPin: db.prepare("DELETE FROM canvas_pins WHERE user_id = ? AND id = ?"),
    sizePin: db.prepare("UPDATE canvas_pins SET size = ?, updated_at = ? WHERE user_id = ? AND id = ?"),
    stats: db.prepare("SELECT key, offered, pins, dismissals, opens, last_spec, updated_at FROM canvas_stats WHERE user_id = ? ORDER BY key"),
    stat: db.prepare("SELECT key, offered, pins, dismissals, opens, last_spec FROM canvas_stats WHERE user_id = ? AND key = ?"),
    ensure: db.prepare("INSERT OR IGNORE INTO canvas_stats (user_id, key, updated_at) VALUES (?, ?, ?)"),
    resetStats: db.prepare("DELETE FROM canvas_stats WHERE user_id = ?"),
    prefs: db.prepare("SELECT locked, learn, updated_at FROM canvas_prefs WHERE user_id = ?"),
    setPrefs: db.prepare(
      "INSERT INTO canvas_prefs (user_id, locked, learn, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET locked = excluded.locked, learn = excluded.learn, updated_at = excluded.updated_at"
    ),
  };
  const bump = {};
  for (const col of Object.values(WHAT)) bump[col] = db.prepare(`UPDATE canvas_stats SET ${col} = ${col} + 1, updated_at = ? WHERE user_id = ? AND key = ?`);
  const setLast = db.prepare("UPDATE canvas_stats SET last_spec = ? WHERE user_id = ? AND key = ?");

  function pinOut(r) {
    let spec = null;
    try {
      const v = W.validate(JSON.parse(r.spec));
      spec = v.ok ? v.value : null;
    } catch (_) {
      spec = null;
    }
    return spec ? { id: r.id, key: r.key, size: SIZES.includes(r.size) ? r.size : "m", spec, pinned_at: r.created_at } : null;
  }

  const store = {
    MAX_PINS,
    cleanKey,
    prefs(uid) {
      const r = q.prefs.get(uid);
      return { locked: !!(r && r.locked), learn: r ? !!r.learn : true };
    },
    setPrefs(uid, p) {
      const cur = store.prefs(uid);
      const next = { locked: p.locked === undefined ? cur.locked : !!p.locked, learn: p.learn === undefined ? cur.learn : !!p.learn };
      q.setPrefs.run(uid, next.locked ? 1 : 0, next.learn ? 1 : 0, iso());
      return next;
    },
    pins(uid) {
      return q.pins.all(uid).map(pinOut).filter(Boolean);
    },
    /** Pin a widget (any shape: it is checked here). Returns { pin } or { error }. */
    pin(uid, widget, size) {
      const v = W.validate(widget);
      if (!v.ok) return { error: v.why };
      if (q.pinCount.get(uid).n >= MAX_PINS) return { error: `You have ${MAX_PINS} pinned widgets, the most there can be. Unpin one first.`, full: true };
      const sz = SIZES.includes(size) ? size : v.value.size || "m";
      const t = iso();
      const info = q.addPin.run(uid, v.key, JSON.stringify(v.value), sz, q.maxPos.get(uid).p + 1, t, t);
      store.count(uid, v.key, "pin", v.value);
      return { pin: pinOut(q.getPin.get(uid, info.lastInsertRowid)) };
    },
    unpin(uid, id) {
      const r = q.getPin.get(uid, id);
      if (!r) return false;
      q.delPin.run(uid, id);
      // Unpinning is tidying the board, not a "no": it is not counted as a dismissal.
      return true;
    },
    resize(uid, id, size) {
      if (!SIZES.includes(size)) return null;
      const r = q.getPin.get(uid, id);
      if (!r) return null;
      q.sizePin.run(size, iso(), uid, id);
      return pinOut(q.getPin.get(uid, id));
    },
    /** One more offered / pin / dismiss / open of a key (nothing while learning is off). */
    count(uid, key, what, spec) {
      const k = cleanKey(key);
      const col = WHAT[what];
      if (!k || !col) return false;
      if (!store.prefs(uid).learn) return false;
      q.ensure.run(uid, k, iso());
      bump[col].run(iso(), uid, k);
      if (what === "pin" && spec) setLast.run(JSON.stringify(spec), uid, k);
      return true;
    },
    stats(uid) {
      return q.stats.all(uid).map((r) => ({ key: r.key, offered: r.offered, pins: r.pins, dismissals: r.dismissals, opens: r.opens, updated_at: r.updated_at }));
    },
    /** What was learned: standing tiles (with the widget each is drawn from) and the keys no longer offered. */
    learned(uid) {
      if (!store.prefs(uid).learn) return { standing: [], suppressed: [], rows: Policy.learn(store.stats(uid)).rows };
      const rows = q.stats.all(uid);
      const L = Policy.learn(rows);
      const standing = [];
      for (const k of L.standing) {
        const r = rows.find((x) => x.key === k);
        let spec = null;
        try {
          const v = r && r.last_spec ? W.validate(JSON.parse(r.last_spec)) : null;
          spec = v && v.ok ? v.value : null;
        } catch (_) {
          spec = null;
        }
        if (spec) standing.push({ key: k, spec });
      }
      return { standing, suppressed: L.suppressed, rows: L.rows };
    },
    suppressed(uid, key) {
      if (!store.prefs(uid).learn) return false;
      const r = q.stat.get(uid, key);
      return !!r && Policy.learn([r]).suppressed.length === 1;
    },
    resetLearning(uid) {
      return q.resetStats.run(uid).changes;
    },
  };
  return store;
}

module.exports = { create, cleanKey, MAX_PINS };
