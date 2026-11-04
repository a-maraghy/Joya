"use strict";
/**
 * Devices: the browsers signed in to Joya, read from the session store.
 *
 * express-session keeps every session in sessions.db (connect-sqlite3, table
 * `sessions(sid, expired, sess)`), and connect-sqlite3 cannot list one user's
 * sessions with their ids -- its all() drops the sid and returns expired rows.
 * So this module reads the file itself, read-only, and only ever writes through
 * the store (destroy), which owns it.
 *
 * A sid is a bearer credential: whoever has one is signed in. It never leaves
 * this process. A row is named by HMAC(key, sid) cut to 12 hex characters,
 * where the key is derived from the session secret (the secret itself is not
 * kept), and a sign-out maps that name back by recomputing it over the
 * viewer's own live sessions -- so a name from one user can never reach
 * another user's session.
 *
 * What a session says about its browser is set at sign-in (server.js):
 *   sess.device = { ua, ip, at }   sess.seenAt = ms, refreshed at most once a minute
 * Sessions older than that change carry neither; they are shown as "Unknown
 * browser", signed in before the last time they were used (expired - maxAge).
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_) {
  Database = null;
}

const COUNT_CACHE_MS = 30 * 1000;

let cfg = null; // { file, key, maxAge, store }
let rodb = null;
const counts = new Map(); // userId -> { at, n }

function configure({ dataDir, secret, maxAge, store, file }) {
  cfg = {
    file: file || path.join(dataDir, "sessions.db"),
    // A key of its own, so the secret that signs cookies is not what names rows.
    key: crypto.createHmac("sha256", String(secret)).update("joya-os device ids v1").digest(),
    maxAge: Number(maxAge) || 8 * 3600 * 1000,
    store: store || null,
  };
  if (rodb) {
    try {
      rodb.close();
    } catch (_) {
      /* already closed */
    }
  }
  rodb = null;
  counts.clear();
}

function idOf(sid) {
  return crypto.createHmac("sha256", cfg.key).update(String(sid)).digest("hex").slice(0, 12);
}

function open() {
  if (rodb) return rodb;
  if (!Database || !cfg || !fs.existsSync(cfg.file)) return null;
  try {
    rodb = new Database(cfg.file, { readonly: true, fileMustExist: true });
    rodb.pragma("busy_timeout = 2000");
  } catch (_) {
    rodb = null;
  }
  return rodb;
}

/** The raw live sessions of one user: [{ sid, expired, sess }]. */
function rawFor(userId) {
  const d = open();
  if (!d || userId == null) return [];
  let rows = [];
  try {
    rows = d.prepare("SELECT sid, expired, sess FROM sessions WHERE expired > ?").all(Date.now());
  } catch (_) {
    return [];
  }
  const out = [];
  for (const r of rows) {
    let s = null;
    try {
      s = JSON.parse(r.sess);
    } catch (_) {
      continue;
    }
    if (!s || !s.authed || s.userId == null || String(s.userId) !== String(userId)) continue;
    out.push({ sid: r.sid, expired: Number(r.expired), sess: s });
  }
  return out;
}

/* ------------------------------------------------------------ user agent --- */

/**
 * Browser and OS family from a User-Agent, without a dependency. Good enough
 * to tell one's own devices apart; not a fingerprint. Order matters: Edge,
 * Opera and Samsung say "Chrome" too, and everything says "Safari".
 */
function parseUA(ua) {
  const s = String(ua || "");
  if (!s.trim()) return { browser: null, os: null, mobile: false, label: "Unknown browser" };
  const ver = (re) => {
    const m = s.match(re);
    return m ? m[1] : "";
  };
  let browser = null;
  let v = "";
  if (/Edg(?:e|A|iOS)?\//.test(s)) (browser = "Edge"), (v = ver(/Edg(?:e|A|iOS)?\/(\d+)/));
  else if (/OPR\/|Opera/.test(s)) (browser = "Opera"), (v = ver(/OPR\/(\d+)/));
  else if (/SamsungBrowser\//.test(s)) (browser = "Samsung Internet"), (v = ver(/SamsungBrowser\/(\d+)/));
  else if (/Firefox\/|FxiOS\//.test(s)) (browser = "Firefox"), (v = ver(/(?:Firefox|FxiOS)\/(\d+)/));
  else if (/CriOS\//.test(s)) (browser = "Chrome"), (v = ver(/CriOS\/(\d+)/));
  else if (/Chrome\/|Chromium\//.test(s)) (browser = /Chromium\//.test(s) ? "Chromium" : "Chrome"), (v = ver(/(?:Chrome|Chromium)\/(\d+)/));
  else if (/Safari\//.test(s) && /Version\//.test(s)) (browser = "Safari"), (v = ver(/Version\/(\d+)/));
  else if (/HeadlessChrome/.test(s)) (browser = "Chrome"), (v = ver(/HeadlessChrome\/(\d+)/));
  else if (/^curl\//i.test(s)) (browser = "curl"), (v = ver(/^curl\/(\d+)/i));

  let os = null;
  let mobile = false;
  if (/iPhone/.test(s)) (os = "iPhone" + (ver(/OS (\d+)[_.]/) ? " · iOS " + ver(/OS (\d+)[_.]/) : "")), (mobile = true);
  else if (/iPad/.test(s)) (os = "iPad" + (ver(/OS (\d+)[_.]/) ? " · iPadOS " + ver(/OS (\d+)[_.]/) : "")), (mobile = true);
  else if (/Android/.test(s)) (os = "Android" + (ver(/Android (\d+)/) ? " " + ver(/Android (\d+)/) : "")), (mobile = true);
  else if (/Windows NT 10\.0/.test(s)) os = "Windows"; // 10 and 11 send the same token
  else if (/Windows NT (\d+\.\d+)/.test(s)) os = "Windows " + ({ "6.3": "8.1", "6.2": "8", "6.1": "7" }[ver(/Windows NT (\d+\.\d+)/)] || "");
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  if (os) os = os.trim();

  const b = browser ? browser + (v ? " " + v : "") : "Unknown browser";
  return { browser, os, mobile, label: os ? b + " on " + os : b };
}

/* --------------------------------------------------------------- listing --- */

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * One user's signed-in browsers, newest activity first. `currentSid` marks
 * "this device". Nothing returned carries a sid.
 */
function listFor(userId, currentSid) {
  const rows = rawFor(userId).map((r) => {
    const dev = r.sess.device && typeof r.sess.device === "object" ? r.sess.device : null;
    const ua = parseUA(dev ? dev.ua : "");
    // rolling: the store's expiry moves with every request, by the session's own lifetime
    // (the desktop app's sessions carry a longer one than the panel's 8 h).
    const own = r.sess.cookie && Number(r.sess.cookie.originalMaxAge) > 0 ? Number(r.sess.cookie.originalMaxAge) : cfg.maxAge;
    const lastUse = r.expired - own;
    const seen = Number(r.sess.seenAt) || null;
    return {
      id: idOf(r.sid),
      current: currentSid != null && r.sid === currentSid,
      known: !!dev,
      label: dev ? (/\bJoyaDesktop\/\d/.test(String(dev.ua || "")) ? "JOYA AI desktop app" + (ua.os ? " on " + ua.os : "") : ua.label) : "Unknown browser",
      desktop: !!(dev && /\bJoyaDesktop\/\d/.test(String(dev.ua || ""))),
      browser: ua.browser,
      os: ua.os,
      mobile: ua.mobile,
      ip: dev && dev.ip ? String(dev.ip).replace(/^::ffff:/, "") : null,
      place: null, // no GeoIP database on the box, and no outside lookup
      signedInAt: dev && dev.at ? iso(Number(dev.at)) : null,
      signedInBefore: dev ? null : iso(lastUse),
      lastSeenAt: iso(Math.max(seen || 0, lastUse)),
      expiresAt: iso(r.expired),
    };
  });
  rows.sort((a, b) => (b.current - a.current) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  counts.set(String(userId), { at: Date.now(), n: rows.length });
  return rows;
}

/** For Users ▸ Manage: how many browsers a user is signed in on, and which. */
function sessionsFor(userId) {
  const list = listFor(userId, null);
  return { count: list.length, list };
}

/** The sidebar badge: a count, cached per user for COUNT_CACHE_MS. */
function countFor(userId) {
  if (!cfg || userId == null) return null;
  const c = counts.get(String(userId));
  if (c && Date.now() - c.at < COUNT_CACHE_MS) return c.n;
  return listFor(userId, null).length;
}

/** The sid behind a row id -- only among this user's own live sessions. */
function resolve(userId, id) {
  if (!/^[0-9a-f]{12}$/.test(String(id || ""))) return null;
  for (const r of rawFor(userId)) if (idOf(r.sid) === id) return r.sid;
  return null;
}

/** Every live sid of a user, optionally but one. */
function sidsFor(userId, exceptSid) {
  return rawFor(userId)
    .map((r) => r.sid)
    .filter((sid) => sid !== exceptSid);
}

function destroy(sid) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.store) return reject(new Error("session store not configured"));
    cfg.store.destroy(sid, (err) => (err ? reject(err) : resolve()));
  });
}

/** Destroy several sessions; returns how many went. */
async function destroyMany(sids) {
  let n = 0;
  for (const sid of sids) {
    try {
      await destroy(sid);
      n++;
    } catch (_) {
      /* one that is already gone is gone */
    }
  }
  return n;
}

function forget(userId) {
  if (userId == null) counts.clear();
  else counts.delete(String(userId));
}

module.exports = { configure, parseUA, listFor, sessionsFor, countFor, resolve, sidsFor, destroy, destroyMany, forget, idOf: (sid) => idOf(sid) };
