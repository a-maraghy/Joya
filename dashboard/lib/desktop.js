"use strict";
/**
 * The JOYA AI desktop app for Windows, the server's side of it (the app is
 * desktop/ in this repo; the design is mockups/desktop-app/DESIGN.md).
 *
 * The app is the Command Center in a transparent window: it loads
 * /joya-ai?shell=desktop (lib/views-joyaai.js renders that mode) and signs in
 * on the site's own pages -- password, then Windows Hello -- inside its
 * webview. Its user agent carries "JoyaDesktop/<version>"; that is how the
 * server tells it from a browser. That string can be typed by anyone, so it
 * only ever changes presentation and the session's length, never what a
 * session may do.
 *
 *   - Session length. A sign-in made in the app lasts DESKTOP_DAYS (14 by
 *     default; Settings > General > Desktop app, 1 to 90, administrators),
 *     counted from the sign-in, not from the last request; then the app asks
 *     for the password and Windows Hello again. A browser keeps its 8 h idle.
 *   - The browser hand-off, for when Windows Hello cannot run inside the
 *     app's webview: the app opens /desktop/link in the default browser with
 *     a challenge (the SHA-256 of a secret only the app holds, PKCE style) and
 *     a loopback port; the person, signed in there (both factors, within the
 *     last LINK_FRESH_MS), presses Link; the browser is sent to the app's
 *     loopback with a one-time code; the app redeems the code together with
 *     the secret (/desktop/redeem). A code is single-use, lives CODE_MS, is
 *     bound to that challenge, and is only taken from the app.
 *   - The update feed: /desktop/latest.json (the signed updater manifest the
 *     app polls) and /desktop/files/<installer> are public -- the app's
 *     updater has no cookie, and both are signed (the installer by the code
 *     signing certificate, the manifest's entry by the updater key). The
 *     download page, /desktop/, is for signed-in people.
 *
 * Pure apart from the store it is given (the panel's settings) and the files
 * directory (JOYA_DESKTOP_DIR, default <data dir>/desktop).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UA_RE = /\bJoyaDesktop\/(\d+\.\d+\.\d+)/;
const DAYS_SETTING = "desktop_session_days";
const DEFAULT_DAYS = 14;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;
const CODE_MS = 2 * 60 * 1000;
const LINK_FRESH_MS = 15 * 60 * 1000;
const MAX_CODES = 50;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes (SHA-256)
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.(exe|msi|zip|sig|cer)$/;

/** The app's version from its user agent, or null for a browser. */
function appVersion(req) {
  const m = UA_RE.exec(String((req && req.get ? req.get("user-agent") : req && req.headers && req.headers["user-agent"]) || ""));
  return m ? m[1] : null;
}
const isApp = (req) => !!appVersion(req);

/** Whole days, MIN_DAYS..MAX_DAYS; anything else is null. */
function cleanDays(v) {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isInteger(n) && n >= MIN_DAYS && n <= MAX_DAYS ? n : null;
}

function create(o) {
  const db = o.db;
  const dir = o.dir;
  const now = o.now || Date.now;
  const codes = new Map(); // code -> { userId, challenge, exp }

  function days() {
    return cleanDays(db.getSetting(DAYS_SETTING, String(DEFAULT_DAYS))) || DEFAULT_DAYS;
  }
  function setDays(n, by) {
    const d = cleanDays(n);
    if (d == null) return false;
    db.setSetting(DAYS_SETTING, String(d), by);
    return true;
  }

  /** A sign-in that just completed in the app: its session lasts days() from now. */
  function markSession(req) {
    if (!isApp(req) || !req.session) return false;
    req.session.desktop = true;
    req.session.cookie.maxAge = days() * DAY_MS;
    return true;
  }
  /**
   * Every request of an app session: past its days, it is signed out (the
   * caller ends its live call); otherwise the cookie keeps the time that is
   * left, so the browser side expires exactly when the server does.
   * Returns "expired", "ok" or null (not an app session).
   */
  function checkSession(req) {
    const s = req.session;
    if (!s || !s.desktop || !s.authed) return null;
    const left = Number(s.authAt || 0) + days() * DAY_MS - now();
    if (!(left > 0)) return "expired";
    s.cookie.maxAge = left;
    return "ok";
  }

  /* ---- the browser hand-off ---- */

  function sweep() {
    const t = now();
    for (const [k, v] of codes) if (v.exp <= t) codes.delete(k);
  }
  /** A one-time code for this user, bound to the app's challenge. */
  function issue(userId, challenge) {
    if (!CHALLENGE_RE.test(String(challenge || "")) || userId == null) return null;
    sweep();
    if (codes.size >= MAX_CODES) return null;
    const code = crypto.randomBytes(32).toString("base64url");
    codes.set(code, { userId, challenge: String(challenge), exp: now() + CODE_MS });
    return code;
  }
  /** The user id the code was issued to, once: the code is spent whether or not the verifier fits. */
  function redeem(code, verifier) {
    sweep();
    if (!CODE_RE.test(String(code || "")) || !VERIFIER_RE.test(String(verifier || ""))) return null;
    const c = codes.get(String(code));
    if (!c) return null;
    codes.delete(String(code));
    const want = Buffer.from(c.challenge);
    const got = Buffer.from(crypto.createHash("sha256").update(String(verifier)).digest("base64url"));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return c.userId;
  }
  const pending = () => (sweep(), codes.size);

  /* ---- the update feed ---- */

  function feedPath(name) {
    if (!dir || !FILE_RE.test(String(name || "")) || name.includes("..")) return null;
    const p = path.join(dir, "files", name);
    return path.dirname(p) === path.join(dir, "files") ? p : null;
  }
  /** latest.json as stored (written by desktop/tools/make-feed.cjs), or null. */
  function latest() {
    if (!dir) return null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"));
      return j && typeof j.version === "string" && j.platforms && typeof j.platforms === "object" ? j : null;
    } catch (_) {
      return null;
    }
  }
  /** What the download page offers: the installer named in latest.json and the certificate, if present. */
  function offer() {
    const j = latest();
    if (!j) return null;
    const w = j.platforms["windows-x86_64"] || {};
    const name = w.url ? decodeURIComponent(String(w.url).split("/").pop()) : null;
    const file = name && feedPath(name);
    let size = null;
    try {
      size = file ? fs.statSync(file).size : null;
    } catch (_) {
      size = null;
    }
    const cert = feedPath("joya-desktop-codesign.cer");
    return { version: j.version, notes: j.notes || "", date: j.pub_date || null, installer: file && size != null ? { name, size } : null, cert: cert && fs.existsSync(cert) ? "joya-desktop-codesign.cer" : null };
  }

  return { days, setDays, markSession, checkSession, issue, redeem, pending, feedPath, latest, offer };
}

module.exports = { create, appVersion, isApp, cleanDays, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS, DAYS_SETTING, CODE_MS, LINK_FRESH_MS, CHALLENGE_RE, VERIFIER_RE, FILE_RE };
