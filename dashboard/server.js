"use strict";
/**
 * JOYA VPS admin dashboard.
 *
 * Listens on 127.0.0.1 only; nginx terminates TLS on :8443 and proxies here.
 * Never run this process as root -- privileged work goes through lib/priv.js.
 */

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const argon2 = require("argon2");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

const db = require("./lib/db");
const deviceSessions = require("./lib/sessions");
const priv = require("./lib/priv");
const catalog = require("./lib/catalog");
const telegram = require("./lib/telegram");
const views = require("./lib/views");
const agentViews = require("./lib/views-agents");
const agentAvatar = require("./lib/agent-avatar");
const channelViews = require("./lib/views-channels");
const topics = require("./lib/topics");
const serviceViews = require("./lib/views-services");
const firewallViews = require("./lib/views-firewall");
const credentialViews = require("./lib/views-credentials");
const addonViews = require("./lib/views-addons");
const guideViews = require("./lib/views-guide");
const accessViews = require("./lib/views-access");
const joyaAiViews = require("./lib/views-joyaai");
const joyaLogic = require("./public/cc-logic");
const joyaSound = require("./public/joya-sound"); // JOYA AI's sounds: the prefs check (users.joya_sound)
const claudeViews = require("./lib/views-claude");
const joyaai = require("./lib/joyaai");
const rbac = require("./lib/rbac");
const totp = require("./lib/totp");
const signin = require("./lib/signin");
const PASSWORD_ONLY = signin.passwordOnly;
// Passkeys (Windows Hello) as the sign-in's second step; the authenticator stays as the fallback.
const passkeys = require("./lib/passkeys");
// Windows Hello (or the code) for every approval that lets something run (2026-10-08).
const stepup = require("./lib/stepup");
const voice = require("./lib/voice");
const voiceShared = require("./lib/voice-shared"); // the guard, the supervisor door, the summaries (was voice-desk.js)
const voiceUsage = require("./lib/voice-usage");
const voicePersona = require("./lib/voice-persona");
const voiceLive = require("./lib/voice-live");
const voiceGptLive = require("./lib/voice-gptlive"); // the live call on GPT-Live (Settings ▸ Voice ▸ Voice model)
// JOYA AI ▸ Settings; the Voice section is rendered and handled with the voice code below.
const settingsRoutes = require("./lib/routes-settings");
// The JOYA AI desktop app for Windows: its render mode, session length, sign-in hand-off and update feed.
const desktopLib = require("./lib/desktop");
const desktopViews = require("./lib/views-desktop");
const UiActions = require("./public/ui-actions.js");
// UI control Phase 2: the ui tokens this server minted, in memory only (lib/ui-relay.js).
const uiRelay = require("./lib/ui-relay").createRelay();
const uiTab = require("./lib/ui-relay").TAB_RE;
// UI control Phase 3: Tier-2 preferences wait for the administrator's confirm (lib/ui-confirm.js).
// An unanswered confirm is not silent: audited, the chip told, the voice says so once (uiConfirmExpired).
const uiConfirms = require("./lib/ui-confirm").createConfirms({ onExpire: (actor, e) => uiConfirmExpired(actor, e) });
// The event streams open per user and tab, so the server can reach a chip (a confirm that expired).
const uiStreams = new Set(); // { actor, tab, res }
function uiConfirmExpired(actor, e) {
  db.logLogin(e.ip || null, actor, "joya-ui", `${e.action} ${JSON.stringify(e.args)} expired, nothing changed`);
  const line = voicePersona.expiredLine(personaOfActor(actor));
  const data = JSON.stringify({ type: "ui-confirm", state: "expired", id: e.id, action: e.action, line });
  for (const st of uiStreams) if (st.actor === actor) st.res.write(`event: ui-confirm\ndata: ${data}\n\n`);
  const call = voiceLive.callFor(actor);
  if (call && call.confirmExpired) call.confirmExpired(e);
}
function personaOfActor(actor) {
  try {
    const u = db.getUserByName(actor);
    return u ? personaOf(u.id) : null;
  } catch (_) {
    return null;
  }
}
/**
 * Open a Tier-2 confirm for `who` ({username, ip, canVoice}): the page shows
 * the question; nothing changes until a click or a heard "yes". persona.set
 * and voice.set need voice.manage (their routes check it again); voice.set
 * never while a live call is open (changing it ends every call).
 */
function uiConfirmOpen(who, v, tab, by) {
  if ((v.action === "persona.set" || v.action === "voice.set") && !who.canVoice) return { error: "this account cannot change voice settings" };
  if (uiVoiceOff(v.action)) return { error: "voice is off" };
  if (v.action === "voice.set" && uiConfirms.anyPending("voice.set")) return { error: "another voice change is already waiting for a confirm" };
  const o = uiConfirms.open({ actor: who.username, action: v.action, args: v.args, tab, ip: who.ip });
  if (o.error) return o;
  db.logLogin(who.ip, who.username, "joya-ui", `${v.action} ${JSON.stringify(v.args)} asked by ${by}: waiting for the administrator's confirm`);
  return { id: o.id, question: UiActions.toast(v.action, v.args) };
}
/** A voice screen action (call.*, voice.set) while voice is off: refused, wherever it comes from. */
function uiVoiceOff(action) {
  return (/^call\./.test(String(action || "")) || action === "voice.set") && !voiceEnabled();
}
/** The administrator's next utterance against a pending confirm (null when none is pending). */
function uiConfirmHeard(who, text, where) {
  const r = uiConfirms.heard(who.username, text, voiceStop);
  if (r && (r.confirmed || r.cancelled)) {
    const e = r.confirmed || r.cancelled;
    db.logLogin(who.ip, who.username, "joya-ui", `${e.action} ${JSON.stringify(e.args)} ${r.confirmed ? "confirmed by a spoken yes" : "cancelled by a spoken no"} (${where})`);
  }
  return r;
}
/** joyaai.call for the live call: a send carrying a ui token binds it to the turn it started. */
function joyaCall(op, params, actor, opts) {
  return joyaai.call(op, params, actor, opts).then((r) => {
    if (op === "send" && params && params.ut && r && r.turn) uiRelay.bind(params.ut, r.turn.id);
    return r;
  });
}
const voiceprintTrial = require("./lib/voiceprint-trial");
const voiceprintLib = require("./lib/voiceprint");
const voiceprintRoutes = require("./lib/voiceprint-routes");
const voiceprintEnrolViews = require("./lib/views-voiceprint-enrol");
const ui = require("./lib/ui");
const { asset } = ui;
const { WebSocketServer } = require("ws");
const voiceGuard = require("./lib/voice-guard");
const voiceIntake = require("./lib/voice-intake");
const voiceTranscribe = require("./lib/voice-transcribe"); // gpt-4o-transcribe, the one transcription model (realtime voice models only)
// The spoken "stop listening" command; the same file runs in the browser.
const voiceStop = require("./public/voice-stop.js");
const chrome = require("./lib/chrome");
const memgraph = require("./lib/memgraph");
const pulse = require("./lib/pulse");

const PORT = Number(process.env.JOYA_PORT || 3000);
const BIND = process.env.JOYA_BIND || "127.0.0.1";
const DATA_DIR = process.env.JOYA_DATA_DIR || "/var/lib/joya-dashboard";
const LOG_DIR = process.env.JOYA_LOG_DIR || "/var/log/joya-dashboard";
const PUBLIC_HOST = process.env.JOYA_PUBLIC_HOST || "localhost";
const PUBLIC_PORT = process.env.JOYA_PUBLIC_PORT || "8443";
// A panel on the owner's own computer (Joya's "this computer" install): plain HTTP on
// localhost, no nginx, no certificate. Only honoured while bound to loopback, so a
// panel reachable from the network always keeps its secure-only cookie and HSTS.
const LOCAL_HTTP =
  process.env.JOYA_LOCAL_HTTP === "1" && /^(127\.0\.0\.1|localhost|::1)$/.test(process.env.JOYA_BIND || "127.0.0.1");

fs.mkdirSync(LOG_DIR, { recursive: true });
const AUTH_LOG = path.join(LOG_DIR, "auth.log");

/**
 * fail2ban watches this file. Keep the format stable -- the filter regex in
 * /etc/fail2ban/filter.d/joya-dashboard.conf depends on it.
 */
function logAuthFailure(ip, reason) {
  const line = `${new Date().toISOString()} joya-dashboard: authentication failure from ${ip} (${reason})\n`;
  fs.appendFile(AUTH_LOG, line, () => {});
}

const app = express();

// nginx is the only thing talking to us, and it is on loopback. Trusting just
// loopback means X-Forwarded-For gives us the real client IP without letting a
// remote client spoof it.
app.set("trust proxy", "loopback");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"], // data: is needed for the TOTP QR code
        // Spoken replies arrive as a WAV body and are played from a blob URL,
        // which is same-origin but is not 'self' as far as CSP is concerned.
        // Without this the audio is fetched, decoded, and then silently refused
        // at the moment it would play.
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        // 'self': the Command Center hosts Joya pages in a same-origin iframe (M-5), so a live call survives moving between them.
        // X-Frame-Options stays SAMEORIGIN (helmet's frameguard default) for older browsers.
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Over plain HTTP on localhost the default upgrade would send every asset to https://localhost.
        ...(LOCAL_HTTP ? { upgradeInsecureRequests: null } : {}),
      },
    },
    hsts: LOCAL_HTTP ? false : { maxAge: 31536000, includeSubDomains: true },
  })
);

/*
 * The desktop app (lib/desktop.js) talks to its own window through Tauri's IPC,
 * which on Windows is a fetch to http://ipc.localhost. Only a request from the
 * app (its user agent) gets that one extra connect-src; everything else in the
 * policy is the same, and a browser never sees it.
 */
app.use((req, res, next) => {
  if (!desktopLib.isApp(req)) return next();
  const h = res.getHeader("Content-Security-Policy");
  if (typeof h === "string") res.setHeader("Content-Security-Policy", h.replace("connect-src 'self'", "connect-src 'self' http://ipc.localhost ipc:"));
  next();
});

app.use(express.urlencoded({ extended: false, limit: "64kb" }));

/** 64KB is the right ceiling for a form; no route here carries a file in a JSON body any more. */
app.use(express.json({ limit: "64kb" }));

/** A body over the limit is a 413 with a reason, not a stack trace. */
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "That is too large to send in one request." });
  }
  return next(err);
});
// Long-lived, because every reference carries a stamp that changes when the
// file does (see asset() in lib/ui.js). The previous hour-long cache with plain
// URLs meant a deployed stylesheet reached a browser that already had the old
// one only when that hour was up -- so a fix could look like it had not shipped.
app.use(
  "/static",
  express.static(path.join(__dirname, "public"), {
    maxAge: "30d",
    setHeaders: (res, filePath) => {
      // A request without a stamp is a bookmark or a hand-typed URL, and must
      // not be cached for a month under a name that will not change.
      if (!/[?&]v=/.test(res.req.originalUrl || "")) {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
      // Eye contact's camera worker (public/joya-presence-worker.js) runs the face model as WebAssembly: its
      // own policy allows compiling that ('wasm-unsafe-eval', never eval of JavaScript) and loading this
      // site's files -- nothing else, no other host. The pages keep the policy above.
      if (path.basename(filePath) === "joya-presence-worker.js") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      }
    },
  })
);

// Browsers and bookmark managers ask for /favicon.ico at the root regardless of
// what the document declares, so serve it there rather than let it 404 on every
// page load. Public on purpose: it is a logo, and requiring a session for it
// would put a 302 in the console instead of a 404.
// Pages link the stamped /static copy; this unstamped one is kept a day, not a
// week, so a new icon replaces the old one in bookmarks within a day.
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "public", ui.appIcons().ico) /* JOYA_APP_ICON: lib/ui.js */, {
    maxAge: "1d",
    headers: { "Content-Type": "image/x-icon" },
  });
});

// The web app manifest (lib/ui.js manifest()): what an installed Joya app is
// called and which icon it wears. Public for the same reason as the icon -- the
// browser fetches it without the session cookie. Pages link it with a stamp
// built from its content, so it is cached long when stamped and briefly when not.
app.get("/manifest.webmanifest", (req, res) => {
  const stamped = req.query.v === ui.MANIFEST_VERSION();
  res.set("Content-Type", "application/manifest+json; charset=utf-8");
  res.set("Cache-Control", stamped ? "public, max-age=2592000, immutable" : "public, max-age=300");
  // The desktop app's start page (http://tauri.localhost) probes this file with a
  // no-cors fetch to see the site is up; helmet's same-origin CORP would make that
  // fetch fail and the app would sit on "Offline". The file is public anyway.
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(JSON.stringify(ui.manifest(), null, 2));
});

/*
 * The app's start card (desktop/dist, served at http://tauri.localhost) checks the site is there
 * with a no-cors fetch before it asks the app to open the Command Center. helmet marks every
 * response Cross-Origin-Resource-Policy: same-origin, which makes the browser refuse that probe
 * (the 0.1.0 app sat on "Offline" for ever). This one answer is cross-origin, says nothing and
 * sets nothing: 204, never cached. Registered before the session middleware, so a probe
 * creates no session and sets no cookie.
 */
app.get("/desktop/ping", (req, res) => {
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", "no-store");
  res.status(204).end();
});
// Kept as a value: the live conversation's WebSocket upgrade reads the same
// session (see liveUpgrade), and an upgrade never passes through app.use.
// The store and the secret are also handed to lib/sessions.js, which lists a
// user's signed-in browsers (Devices) and signs them out through this store.
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
// The desktop app's sessions last longer (14 days by default, Settings > General; lib/desktop.js).
const desktop = desktopLib.create({ db, dir: process.env.JOYA_DESKTOP_DIR || path.join(DATA_DIR, "desktop") });
const sessionStore = new SQLiteStore({ db: "sessions.db", dir: DATA_DIR });
const sessionMw = session({
    store: sessionStore,
    secret: (() => {
      const secret = loadOrCreateSessionSecret();
      deviceSessions.configure({ dataDir: DATA_DIR, secret, maxAge: SESSION_MAX_AGE, store: sessionStore });
      return secret;
    })(),
    name: "joya.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: LOCAL_HTTP ? "auto" : true, // behind TLS, except a panel on the owner's own computer (LOCAL_HTTP)
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE,
    },
  });
app.use(sessionMw);

function loadOrCreateSessionSecret() {
  const p = path.join(DATA_DIR, "session.secret");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (_) {
    const secret = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(p, secret, { mode: 0o600 });
    return secret;
  }
}

/**
 * Pages are never cached.
 *
 * Everything here is behind a session and specific to who is asking, so a
 * cached copy is both wrong for the next person and stale for this one. It also
 * kept the fix for a visual bug from arriving: the page came from cache, so it
 * carried the old stylesheet URL, so the new stylesheet was never asked for --
 * and the bug looked unfixed twice over.
 *
 * Static files are served before this and keep their own long, stamped cache.
 */
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  next();
});

/* ---------------------------------------------------------------- CSRF ---- */

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrf = req.session.csrf;
  next();
});

function requireCsrf(req, res, next) {
  const supplied = req.body && req.body._csrf;
  if (!supplied || supplied !== req.session.csrf) {
    return res.status(403).send(views.error("Request rejected", "Invalid CSRF token. Reload the page and try again."));
  }
  next();
}

/* ---------------------------------------------------------------- auth ---- */

/**
 * Resolve the signed-in user on every request rather than trusting the session
 * copy. A role edit, a disabled account, or a deleted user has to take effect
 * on the very next request -- caching permissions in the session would leave a
 * revoked operator holding their old powers until they happened to sign out.
 */
function loadActor(req, res, next) {
  req.me = null;
  req.perm = rbac.actor(null);
  // The desktop app's session, past its days: signed out here (its call too); the app asks for the password and Windows Hello again.
  if (desktop.checkSession(req) === "expired") {
    endLiveCallsForSession(req.sessionID, "signed-out");
    db.logLogin(req.ip, req.session.username || "", "desktop", `desktop app session ended after ${desktop.days()} days`);
    req.session.authed = false;
    delete req.session.userId;
    req.session.desktopExpired = true;
  }
  if (req.session && req.session.authed && req.session.userId) {
    const me = db.getUser(req.session.userId);
    if (!me || me.disabled) {
      // `revoked` is a flag, not a message: anything rendered on the sign-in
      // page that came out of a URL is text an attacker can put in front of
      // someone who is about to type their password.
      endLiveCallsForSession(req.sessionID, "signed-out");
      return req.session.destroy(() => res.redirect("/login?revoked=1"));
    }
    req.me = me;
    req.perm = rbac.actor(me.role);
    // Devices' "last seen". At most once a minute, so a busy page does not
    // rewrite its session row on every poll.
    const now = Date.now();
    if (!(req.session.seenAt > now - 60 * 1000)) req.session.seenAt = now;
  }
  next();
}
app.use(loadActor);
// Whether this viewer gets the dock's microphone (voiceDockOk, with the voice code): pages only.
app.use((req, res, next) => {
  if (req.method !== "GET" || !req.me || /^\/(?:joya)-ai\/api\//.test(req.path) || /\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
  voiceDockOk(req).then(
    (ok) => {
      req.voiceMic = ok;
      next();
    },
    () => next()
  );
});

// The frame's badges and health chip, from a shared 30-second cache (see
// lib/chrome.js). A change made through the panel forgets the cache, so the
// page it redirects to counts what is true now rather than half a minute ago.
chrome.configure({ priv, db, catalog, devicesFor: (userId) => deviceSessions.countFor(userId), voiceOff: () => !voiceEnabled() });

// The Machine core's live feed: one poller for every viewer, reading the
// helper's pulse-feed, this panel's own sign-ins and audit log, and JOYA AI's
// ledger. It only runs while someone has the overview open.
const pulseFeed = pulse.createFeed({ priv, db, joyaai, auditLog: path.join(LOG_DIR, "audit.log") });
app.use((req, res, next) => {
  if (req.method === "POST") chrome.invalidate();
  next();
});
app.use(chrome.middleware());

function requireAuth(req, res, next) {
  if (req.me) return next();
  return res.redirect("/login");
}

/** Where a signed-in person lands: the app always on its own render mode of the Command Center. */
function landingFor(req, perm) {
  const to = rbac.landing(perm || req.perm);
  return desktopLib.isApp(req) && (perm || req.perm).can("joyaai.use") ? "/joya-ai?shell=desktop" : to;
}

/** The viewer context every view forwards into the page shell. */
function ctx(req, dash) {
  return {
    name: req.me ? req.me.display_name || req.me.username : "",
    roleLabel: req.me && req.me.role ? req.me.role.label : null,
    perm: req.perm,
    dash: dash || null,
    chrome: req.chrome || null,
    voice: !!req.voiceMic, // the dock's mic: voice on, a key, and voice.use (see voiceDockOk)
    core: req.me ? joyaLogic.normCore(req.me.joya_core) : null, // the dock draws the same core (D: joya-core-d.js, E: joya-core-bot.js)
    botHead: req.me ? joyaLogic.normBotHead(req.me.joya_bot_head) : null,
    botColors: req.me ? joyaLogic.botColorsJson(req.me.joya_bot_colors) : null,
    botFace: req.me ? joyaLogic.normBotFace(req.me.joya_bot_face) : null,
  };
}

/**
 * Guard a route with a permission. Denial renders a page rather than a bare
 * 403: the person hitting it is signed in and legitimate, and "your role does
 * not include this" is a far more actionable answer than a status code.
 */
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.redirect("/login");
    if (req.perm.can(perm)) return next();
    return res
      .status(403)
      .send(accessViews.denied({ csrf: res.locals.csrf, user: ctx(req), perm }));
  };
}

/**
 * Scope guard for the per-agent and per-channel routes. Out-of-scope resources
 * are reported as absent rather than forbidden -- telling someone an agent
 * exists but is not theirs leaks the fleet's shape to a role that was
 * deliberately narrowed.
 */
function requireAgentScope(req, res, next) {
  if (req.perm.seesAgent(req.params.slug)) return next();
  return res.status(404).send(views.error("Not found", "No such agent."));
}

function requireChannelScope(req, res, next) {
  if (req.perm.seesChannel(req.params.slug)) return next();
  return res.status(404).send(views.error("Not found", "No such channel."));
}

/** Drop anything the actor's role does not scope them to. */
const scopeAgents = (req, agents) => (agents || []).filter((a) => req.perm.seesAgent(a.slug));
const scopeChannels = (req, channels) =>
  (channels || []).filter((c) => req.perm.seesChannel(c.slug));

/**
 * An argon2id hash of a random value nobody knows. When a login names a
 * username that does not exist we verify against this instead of returning
 * early, so a missing account and a wrong password cost the same wall-clock
 * time. A hand-written constant would not do: argon2 rejects a malformed
 * digest immediately, which is exactly the timing signal we are removing.
 */
const decoyHash = argon2
  .hash(crypto.randomBytes(32).toString("hex"), { type: argon2.argon2id })
  .catch(() => null);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Try again later.",
});

// The passkey half of the second step: the options call and the answer are two
// requests per sign-in, so they get their own, roomier budget. A passkey cannot
// be guessed; this is about load, and the per-attempt cap below is the guard.
const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ------------------------------------------------------- password only --- */

// Password-only sign-in (lib/signin.js): no authenticator and no passkeys, so their
// routes do not exist. Registered before them, so nothing below needs to check.
const SECOND_FACTOR_ROUTES = /^\/(account\/authenticator|account\/passkeys|login\/passkey|users\/\d+\/totp)(\/|$)/;
if (PASSWORD_ONLY)
  app.use((req, res, next) => (SECOND_FACTOR_ROUTES.test(req.path) ? res.status(404).send(views.error("Not found", "No such page.")) : next()));

/* ------------------------------------------------------------ first run --- */

/**
 * /setup creates the admin account, so an unauthenticated /setup on a public
 * port is a land-grab risk: whoever loads it first owns the panel. It is
 * therefore gated behind a high-entropy token written to disk at first start,
 * readable only by root and the service account.
 *
 * Once an admin exists the endpoint is dead regardless of token.
 */
function getSetupToken() {
  const p = path.join(DATA_DIR, "setup.token");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (_) {
    const token = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(p, token, { mode: 0o600 });
    return token;
  }
}

function setupTokenValid(supplied) {
  const expected = getSetupToken();
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check length first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True until the very first account exists. */
const noUsersYet = () => db.userCount() === 0;

const TOTP_ISSUER = "Joya";

/**
 * The enrolment URI an authenticator app scans.
 *
 * Microsoft Authenticator lists an entry as "issuer — account name", and a
 * phone holding entries for several systems has nothing but that line to tell
 * them apart. So the account name is the person's email rather than the local
 * username, which means nothing once it is off this machine. The secret and the
 * algorithm are untouched: this is plain RFC 6238 either way, which is what
 * Microsoft Authenticator stores under "Other account".
 */
function enrolUri(user, secret) {
  return authenticator.keyuri(user.email || user.username, TOTP_ISSUER, secret);
}

const enrolQr = (user, secret) =>
  QRCode.toDataURL(enrolUri(user, secret), { margin: 1, width: 240 });

app.get("/setup", async (req, res) => {
  if (!noUsersYet()) return res.redirect("/login");
  if (!setupTokenValid(req.query.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  res.send(views.setup({ csrf: res.locals.csrf, token: req.query.token, passwordOnly: PASSWORD_ONLY }));
});

app.post("/setup", requireCsrf, async (req, res) => {
  if (!noUsersYet()) return res.redirect("/login");
  if (!setupTokenValid(req.body.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  const { username, password, password2 } = req.body;
  const email = field(req.body, "email");
  const errors = [];
  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    errors.push("Username must be 3-32 characters (letters, digits, . _ -).");
  if (!EMAIL_RE.test(email)) errors.push("Enter an email address for this account.");
  if (!password || password.length < 12)
    errors.push("Password must be at least 12 characters.");
  if (password !== password2) errors.push("Passwords do not match.");
  if (errors.length)
    return res.status(400).send(
      views.setup({
        csrf: res.locals.csrf,
        token: req.body.token,
        form: { username, email },
        errors,
        passwordOnly: PASSWORD_ONLY,
      })
    );

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const secret = authenticator.generateSecret();
  const role = db.getRoleByName("administrator");
  db.createUser({
    username,
    displayName: username,
    email,
    passwordHash: hash,
    totpSecret: secret,
    roleId: role.id,
    createdBy: "setup",
  });

  // Password-only (lib/signin.js): nothing to enrol, the account is ready now.
  if (PASSWORD_ONLY) {
    db.confirmUserTotp(db.getUserByName(username).id);
    return res.send(views.setupDone({ passwordOnly: true }));
  }
  const qr = await enrolQr({ username, email }, secret);
  res.send(views.totpEnroll({ csrf: res.locals.csrf, qr, secret, account: email }));
});

app.post("/setup/confirm", requireCsrf, async (req, res) => {
  // Only ever completes the very first account; every later user enrols by
  // signing in, so this stays a one-shot endpoint rather than a way to confirm
  // an arbitrary account's second factor.
  const first = db.listUsers()[0];
  if (!first || db.userCount() !== 1 || first.totp_confirmed) return res.redirect("/login");
  const token = String(req.body.token || "").replace(/\s/g, "");
  if (!authenticator.check(token, first.totp_secret)) {
    return res.status(400).send(
      views.totpEnroll({
        csrf: res.locals.csrf,
        qr: await enrolQr(first, first.totp_secret),
        secret: first.totp_secret,
        account: first.email || first.username,
        error: "That code was not accepted. Check your device clock and try the next code.",
      })
    );
  }
  db.confirmUserTotp(first.id);
  res.send(views.setupDone());
});

/* --------------------------------------------------------------- login ---- */

app.get("/login", (req, res) => {
  if (noUsersYet()) return res.redirect("/setup");
  if (req.me) return res.redirect(landingFor(req));
  // A half-finished sign-in is abandoned by coming back here.
  if (req.session) delete req.session.pendingLogin;
  const app_ = desktopLib.isApp(req);
  const expired = app_ && req.session && req.session.desktopExpired;
  res.send(
    views.login({
      csrf: res.locals.csrf,
      error: req.query.revoked ? "Your access has been changed. Sign in again." : req.query.again ? "Invalid credentials." : expired ? `The app's ${desktop.days()} days are up. Sign in again: your password, then Windows Hello.` : null,
      passkeys: !!passkeys.rpFor(req),
      desktop: app_,
      days: desktop.days(),
      passwordOnly: PASSWORD_ONLY,
    })
  );
});

app.post("/login", loginLimiter, requireCsrf, async (req, res) => {
  if (noUsersYet()) return res.redirect("/setup");

  const ip = req.ip;
  const { username, password, token } = req.body;
  const reject = (reason) => {
    db.logLogin(ip, username || "", "fail", reason);
    logAuthFailure(ip, reason);
    return res
      .status(401)
      .send(views.login({ csrf: res.locals.csrf, error: "Invalid credentials.", passwordOnly: PASSWORD_ONLY }));
  };

  // `second=passkey` (set by public/passkey.js when the page offers it): no code
  // now, the second step comes next. Without it a missing code is a missing
  // field, exactly as before passkeys existed.
  const viaPasskey = !String(token || "").trim() && req.body.second === "passkey" && !!passkeys.rpFor(req);
  if (!username || !password || (!token && !viaPasskey && !PASSWORD_ONLY)) return reject("missing field");
  const account = db.getUserByName(String(username));

  /**
   * The passkey step is reached whatever happened to the password.
   *
   * Asking for the code on the same form meant a wrong password and a wrong
   * code got the same answer, so a password could not be tested on its own.
   * A second step must not give that up: the next page looks the same for a
   * right password, a wrong one and an unknown user, and the passkey prompt it
   * starts names no credentials (a discoverable-credential request), so
   * nothing on it says which case this is. Only the end of the step tells,
   * and it tells "Invalid credentials" for all of them.
   */
  const toSecondStep = (userId, pwOk, reason) => {
    if (!pwOk) {
      db.logLogin(ip, username || "", "fail", reason);
      logAuthFailure(ip, reason);
    }
    req.session.pendingLogin = { userId: pwOk ? userId : null, username: String(username).slice(0, 64), at: Date.now(), fails: 0 };
    return res.redirect("/login/verify");
  };

  // Verify a throwaway hash for an unknown username so a missing account and a
  // wrong password take the same time. Argon2 is slow enough that skipping it
  // would make user enumeration trivial from a stopwatch.
  if (!account) {
    const decoy = await decoyHash;
    if (decoy) await argon2.verify(decoy, String(password)).catch(() => false);
    return viaPasskey ? toSecondStep(null, false, "unknown user") : reject("unknown user");
  }
  if (account.disabled) return viaPasskey ? toSecondStep(null, false, "account disabled") : reject("account disabled");

  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(account.password_hash, password);
  } catch (_) {
    passwordOk = false;
  }
  if (!passwordOk) return viaPasskey ? toSecondStep(null, false, "bad password") : reject("bad password");
  if (viaPasskey) return toSecondStep(account.id, true, null);

  // Password-only (lib/signin.js): the password is the whole sign-in.
  if (PASSWORD_ONLY)
    return completeLogin(req, res, account, "password only", (err, to) =>
      err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
    );

  // Checked and spent in one step. A code stayed usable for its whole
   // ninety-second life before, so one seen over a shoulder -- or in a screen
  // share -- was worth a session to anyone who also had the password. Only a
  // successful sign-in spends one, so retrying after a mistyped password still
  // works with the code already on screen.
  if (!totp.verifyAndConsume(account, token)) return reject("bad totp");

  // First successful sign-in also completes enrolment: producing a valid code
  // is the proof that the authenticator was set up correctly.
  if (!account.totp_confirmed) db.confirmUserTotp(account.id);
  completeLogin(req, res, account, null, (err, to) =>
    err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
  );
});

/**
 * Both factors are in: make this browser signed in. `done(err, landing)`.
 * `how` is the audit detail (null for the code, as it always was).
 */
function completeLogin(req, res, account, how, done) {
  const ip = req.ip;
  db.touchUserLogin(account.id);

  // Regenerate the session on privilege change to prevent fixation.
  const csrf = req.session.csrf;
  // A sign-in started from the desktop app's browser hand-off comes back to it (lib/desktop.js).
  const after = /^\/desktop\/link\?c=[A-Za-z0-9_-]{43}&p=\d{4,5}$/.test(String(req.session.afterLogin || "")) ? req.session.afterLogin : null;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.authed = true;
    req.session.userId = account.id;
    req.session.username = account.username;
    req.session.csrf = csrf;
    // When both factors were last shown: adding a passkey soon after needs no code again.
    req.session.authAt = Date.now();
    // What Devices shows for this browser. The user agent is capped: it is
    // the client's own text, stored until the session ends.
    req.session.device = { ua: String(req.get("user-agent") || "").slice(0, 300), ip, at: Date.now() };
    req.session.seenAt = Date.now();
    deviceSessions.forget(account.id);
    // Signed in inside the desktop app: its session lasts the app's days, from now.
    const inApp = desktop.markSession(req);
    db.logLogin(ip, account.username, "success", (how ? how : "") + (inApp ? (how ? ", " : "") + "desktop app (" + desktop.days() + " days)" : "") || null);
    const actor = rbac.actor(account.role);
    done(null, after || landingFor(req, actor));
  });
}

/* --- the second step: a passkey, or the authenticator code ------------- */

// A half-finished sign-in lasts this long, and survives this many failed tries.
const PENDING_LOGIN_MS = 5 * 60 * 1000;
const PENDING_LOGIN_TRIES = 5;

/** The pending sign-in of this browser, or null (expired or none). */
function pendingLogin(req) {
  const p = req.session && req.session.pendingLogin;
  if (!p || !(Date.now() - p.at < PENDING_LOGIN_MS) || p.fails >= PENDING_LOGIN_TRIES) {
    if (req.session) delete req.session.pendingLogin;
    return null;
  }
  return p;
}

/** The account a pending sign-in may finish as: password right, still enabled. */
function pendingAccount(p) {
  if (!p || !p.userId) return null;
  const a = db.getUser(p.userId);
  return a && !a.disabled ? a : null;
}

/** One failed second step: logged, counted, and the sign-in dropped at the cap. */
function secondStepFailed(req, p, reason) {
  p.fails = (p.fails || 0) + 1;
  // A wrong password was logged at the first step; the step itself is logged
  // only for a sign-in that could have succeeded, so one attempt is one line.
  if (p.userId) {
    db.logLogin(req.ip, p.username, "fail", reason);
    logAuthFailure(req.ip, reason);
  }
  if (p.fails >= PENDING_LOGIN_TRIES) delete req.session.pendingLogin;
}

app.get("/login/verify", (req, res) => {
  if (req.me) return res.redirect(landingFor(req));
  if (PASSWORD_ONLY) return res.redirect("/login");
  const p = pendingLogin(req);
  if (!p) return res.redirect("/login");
  const rp = passkeys.rpFor(req);
  res.send(
    views.loginVerify({
      csrf: res.locals.csrf,
      username: p.username,
      passkeys: !!rp,
      primary: passkeys.primaryOrigin(),
      error: req.query.err ? "That did not work. Try again, or use your authenticator code." : null,
      desktop: desktopLib.isApp(req),
    })
  );
});

/** Options for navigator.credentials.get(): the same shape for every pending sign-in. */
app.post("/login/passkey/options", passkeyLimiter, requireCsrf, async (req, res) => {
  const p = pendingLogin(req);
  if (!p) return res.status(409).json({ error: "Start again.", restart: true });
  const rp = passkeys.rpFor(req);
  if (!rp) return res.status(400).json({ error: "Passkeys do not work at this address. Use your authenticator code." });
  req.session.pendingLogin.slot = req.session.pendingLogin.slot || {};
  res.json({ options: await passkeys.loginOptions(rp, req.session.pendingLogin.slot) });
});

app.post("/login/passkey", passkeyLimiter, requireCsrf, async (req, res) => {
  const p = pendingLogin(req);
  if (!p) return res.status(409).json({ error: "Start again.", restart: true });
  const rp = passkeys.rpFor(req);
  const account = pendingAccount(p);
  const fail = (reason) => {
    secondStepFailed(req, p, "bad passkey: " + reason);
    // One answer for every failure: which part was wrong is not said.
    return res.status(401).json({ error: "Invalid credentials.", restart: !req.session.pendingLogin });
  };
  if (!rp) return fail("address not allowed (" + passkeys.hostOf(req) + ")");
  p.slot = p.slot || {};
  if (!account) {
    // A wrong password: spend the challenge all the same, then refuse.
    passkeys.discardChallenge(p.slot);
    return fail("password was not accepted");
  }
  const r = await passkeys.verifyAuthentication(account, rp, p.slot, req.body && req.body.response);
  if (!r.ok) return fail(r.error);
  delete req.session.pendingLogin;
  completeLogin(req, res, account, `passkey "${r.passkey.name}" (${rp.rpID})`, (err, to) =>
    err ? res.status(500).json({ error: "Session error." }) : res.json({ ok: true, redirect: to })
  );
});

/** The fallback: the authenticator code, on the same pending sign-in. */
app.post("/login/code", loginLimiter, requireCsrf, (req, res) => {
  if (PASSWORD_ONLY) return res.redirect("/login");
  const p = pendingLogin(req);
  if (!p) return res.redirect("/login");
  const account = pendingAccount(p);
  if (!account || !totp.verifyAndConsume(account, req.body.token)) {
    if (account) secondStepFailed(req, p, "bad totp");
    // As on the one-step form: a wrong code and a wrong password look the
    // same, so the sign-in starts again rather than offering another try here.
    delete req.session.pendingLogin;
    return res.redirect("/login?again=1");
  }
  if (!account.totp_confirmed) db.confirmUserTotp(account.id);
  delete req.session.pendingLogin;
  completeLogin(req, res, account, null, (err, to) =>
    err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
  );
});

app.post("/logout", requireCsrf, (req, res) => {
  endLiveCallsForSession(req.sessionID, "signed-out"); // this device's live call ends with its session
  req.session.destroy(() => res.redirect("/login"));
});

/* ------------------------------------------------------ the desktop app --- */

/*
 * The JOYA AI desktop app (lib/desktop.js). The feed and the files are public:
 * the app's updater has no cookie, and every file there is signed. The
 * download page and the sign-in hand-off are for signed-in people.
 */
app.get("/desktop/latest.json", (req, res) => {
  const j = desktop.latest();
  res.set("Cache-Control", "no-cache");
  if (!j) return res.status(404).json({ error: "No release has been published." });
  res.json(j);
});
app.get("/desktop/files/:name", (req, res) => {
  const p = desktop.feedPath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).send("Not found");
  res.set("Cache-Control", "public, max-age=300");
  res.set("X-Content-Type-Options", "nosniff");
  res.download(p, req.params.name);
});
app.get(["/desktop", "/desktop/"], requireAuth, (req, res) => {
  res.send(desktopViews.download({ csrf: res.locals.csrf, user: ctx(req), offer: desktop.offer(), days: desktop.days() }));
});

/** The hand-off's two values, checked: the app's challenge and its loopback port. */
function linkArgs(q) {
  const c = String((q && q.c) || "");
  const p = Number((q && q.p) || 0);
  return desktopLib.CHALLENGE_RE.test(c) && Number.isInteger(p) && p >= 1024 && p <= 65535 ? { c, p } : null;
}
// The hand-off's own budget: a link page, its Link and the app's redeem are three requests per sign-in.
const desktopLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.get("/desktop/link", desktopLimiter, (req, res) => {
  const a = linkArgs(req.query);
  if (!a) return res.status(400).send(desktopViews.link({ error: "This link is not complete. Press \u201cSign in in your browser\u201d in the app again." }));
  if (!req.me) {
    // Sign in here first (both factors), then back to this page.
    req.session.afterLogin = `/desktop/link?c=${a.c}&p=${a.p}`;
    return res.redirect("/login");
  }
  const fresh = Date.now() - Number(req.session.authAt || 0) < desktopLib.LINK_FRESH_MS;
  res.send(desktopViews.link({ csrf: res.locals.csrf, username: req.me.username, challenge: a.c, port: a.p, stale: !fresh, days: desktop.days() }));
});
app.post("/desktop/link", desktopLimiter, requireAuth, requireCsrf, (req, res) => {
  const a = linkArgs(req.body);
  if (!a) return res.status(400).send(desktopViews.link({ error: "This link is not complete. Press \u201cSign in in your browser\u201d in the app again." }));
  if (!(Date.now() - Number(req.session.authAt || 0) < desktopLib.LINK_FRESH_MS)) return res.redirect(`/desktop/link?c=${a.c}&p=${a.p}`);
  const code = desktop.issue(req.me.id, a.c);
  if (!code) return res.status(429).send(desktopViews.link({ error: "Too many links are waiting. Try again in two minutes." }));
  db.logLogin(req.ip, req.me.username, "desktop", "desktop app sign-in: a one-time link code issued in the browser (2 min)");
  res.send(desktopViews.linked({ to: `http://127.0.0.1:${a.p}/joya-callback?code=${code}` }));
});
/** "Sign in again" on a stale browser session: this browser signs out, then signs in and comes back. */
app.post("/desktop/link/again", requireCsrf, (req, res) => {
  const a = linkArgs(req.body);
  if (!a) return res.redirect("/login");
  endLiveCallsForSession(req.sessionID, "signed-out");
  const csrf = req.session.csrf;
  req.session.regenerate(() => {
    req.session.csrf = csrf;
    req.session.afterLogin = `/desktop/link?c=${a.c}&p=${a.p}`;
    res.redirect("/login");
  });
});
/** The app redeems the code with its secret (only from the app). */
app.get("/desktop/redeem", desktopLimiter, (req, res) => {
  if (!desktopLib.isApp(req)) return res.status(403).send(views.error("Not here", "This address is for the JOYA AI desktop app."));
  const userId = desktop.redeem(req.query.code, req.query.v);
  const account = userId != null ? db.getUser(userId) : null;
  if (!account || account.disabled) {
    db.logLogin(req.ip, "", "fail", "desktop app hand-off code refused");
    logAuthFailure(req.ip, "desktop hand-off code refused");
    return res.redirect("/login?again=1");
  }
  completeLogin(req, res, account, "browser hand-off", (err, to) =>
    err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
  );
});

/* ----------------------------------------------------------- dashboard ---- */

function systemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  let diskTotal = null;
  let diskFree = null;
  try {
    const st = fs.statfsSync("/");
    diskTotal = st.blocks * st.bsize;
    diskFree = st.bavail * st.bsize;
  } catch (_) {
    /* statfsSync needs Node 18.15+; degrade gracefully */
  }
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    uptimeSec: os.uptime(),
    loadavg: os.loadavg(),
    cpus: cpus.length,
    cpuModel: cpus.length ? cpus[0].model.replace(/\s+/g, " ").trim() : null,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    // The panel's own uptime, which is not the machine's: a dashboard that
    // restarted an hour ago on a host up for 40 days is worth being able to see.
    panelUptimeSec: Math.floor(process.uptime()),
    panelRssBytes: process.memoryUsage().rss,
    memTotal: total,
    memUsed: total - free,
    diskTotal,
    diskUsed: diskTotal != null ? diskTotal - diskFree : null,
  };
}

/**
 * Fetch several privileged facts at once, tolerating individual failures.
 *
 * A dashboard that 500s because one helper call failed is worse than one that
 * renders with a gap: the whole point of the page is to tell you what is wrong.
 */
async function gather(map) {
  const keys = Object.keys(map);
  const settled = await Promise.allSettled(keys.map((k) => map[k]()));
  const out = { errors: {} };
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") out[keys[i]] = result.value;
    else out.errors[keys[i]] = result.reason.message;
  });
  return out;
}

/**
 * The unit list, at most UNITS_MS old, shared by every overview's poll. Each
 * fresh read is folded into the frame's cache so badge, chip and page agree.
 */
const UNITS_MS = 10 * 1000;
let unitsCache = { at: 0, list: null, pending: null };
function freshServices() {
  if (unitsCache.list && Date.now() - unitsCache.at < UNITS_MS) return Promise.resolve(unitsCache.list);
  if (!unitsCache.pending) {
    unitsCache.pending = priv
      .serviceList()
      .then((list) => {
        unitsCache = { at: Date.now(), list, pending: null };
        chrome.prime({ services: list });
        return list;
      })
      .catch((e) => {
        unitsCache.pending = null;
        throw e;
      });
  }
  return unitsCache.pending;
}
function primeFrame(req, services) {
  unitsCache = { at: Date.now(), list: services, pending: null };
  const merged = chrome.prime({ services });
  if (merged && req.chrome) req.chrome = chrome.forActor(req.perm, merged);
}

// `/` is the default landing, not a page: JOYA AI for those who may use it,
// else the first dashboard the role can open (rbac.landing). A 302 so the
// default can change again; the OS overview itself lives at /os.
app.get("/", requireAuth, (req, res) => res.redirect(302, landingFor(req)));

app.get("/os", requireAuth, requirePerm("os.view"), async (req, res) => {
  const data = await gather({
    status: () => priv.status(),
    services: () => priv.serviceList(),
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
    audit: () => (req.perm.can("audit.view") ? priv.auditTail(14) : Promise.resolve(null)),
  });
  if (Array.isArray(data.services)) primeFrame(req, data.services);
  res.send(
    views.osDashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      stats: systemStats(),
      status: data.status || { services: {}, jails: {} },
      statusError: data.errors.status || null,
      services: chrome.visibleServices(data.services || [], req.perm),
      agents: data.agents || [],
      channels: data.channels || [],
      graph: pulse.buildGraph({
        services: chrome.visibleServices(data.services || [], req.perm),
        agents: scopeAgents(req, data.agents),
        channels: scopeChannels(req, data.channels),
        detail: new Map(catalog.OS_SERVICES.map((s) => [s.unit, s])),
      }),
      totals: await pulseFeed.getTotals(),
      probe: data.probe || null,
      logins: db.recentLogins(20),
      audit: data.audit || null,
      users: req.perm.can("users.view") ? db.listUsers() : null,
      roles: req.perm.can("roles.view") ? db.listRoles() : null,
      devices: req.perm.can("keys.pair") ? db.listDevices() : null,
    })
  );
});

/**
 * The Machine core's events since `since` (a sequence number this endpoint
 * handed out), plus the units' current states from the shared 30 s cache.
 * Cheap on purpose: the page asks every few seconds, and however many pages
 * ask, the sources are read at most once per pulse.MIN_INTERVAL_MS.
 */
app.get("/api/os/pulse", requireAuth, requirePerm("os.view"), async (req, res) => {
  const since = /^[0-9]{1,12}$/.test(String(req.query.since || "")) ? Number(req.query.since) : 0;
  const wantTotals = since === 0 || req.query.totals === "1";
  try {
    await Promise.race([pulseFeed.poll(), new Promise((r) => setTimeout(r, 2500))]);
  } catch (_) {
    /* the feed logs its own failures; an empty answer is still an answer */
  }
  let all = [];
  try {
    all = await freshServices();
  } catch (_) {
    const facts = (await chrome.facts()) || {};
    all = Array.isArray(facts.services) ? facts.services : [];
  }
  const services = chrome.visibleServices(all, req.perm);
  const seen = new Set(services.map((s) => s.unit));
  const canAudit = req.perm.can("audit.view");
  const allow = (e) => {
    if (e.type === "audit") return canAudit;
    if (e.type === "start") return seen.has(e.unit);
    if (e.type === "reply") return seen.has("joya-agent@" + e.agent);
    return true;
  };
  const events = pulseFeed.since(since, allow).map((e) => {
    const o = { seq: e.seq, type: e.type, at: e.at };
    for (const k of ["unit", "jail", "agent", "source", "action", "n"]) if (e[k] != null) o[k] = e[k];
    return o;
  });
  res.set("Cache-Control", "no-store");
  res.json({
    seq: pulseFeed.seq,
    events,
    units: services.map((s) => ({ unit: s.unit, active: s.active, since: pulse.shortSince(s.since), memory: s.memory })),
    totals: wantTotals ? await pulseFeed.getTotals() : undefined,
  });
});

app.get("/api/stats", requireAuth, requirePerm("os.view"), async (req, res) => {
  try {
    res.json({ stats: systemStats(), status: await priv.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- keys ---- */

app.get("/keys", requireAuth, requirePerm("keys.view"), async (req, res) => {
  try {
    const keys = await priv.listAllKeys();
    res.send(
      views.keys({
        csrf: res.locals.csrf,
        user: ctx(req),
        keys,
        devices: db.listDevices(),
        canManage: req.perm.can("keys.manage"),
        canPair: req.perm.can("keys.pair"),
        codes: req.perm.can("keys.pair") ? db.listPairingCodes() : [],
        // A code just created: shown once, on the page the create redirected to.
        newCode: req.perm.can("keys.pair") && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(String(req.query.code || "")) ? String(req.query.code) : null,
        publicHost: PUBLIC_HOST,
        publicPort: PUBLIC_PORT,
        flash: req.query.msg || null,
        flashError: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not read keys", e.message));
  }
});

app.post("/keys/add", requireAuth, requirePerm("keys.manage"), requireCsrf, async (req, res) => {
  const { target_user, pubkey, label } = req.body;
  const parsed = parsePublicKey(pubkey);
  if (!parsed)
    return res.redirect("/keys?err=" + encodeURIComponent("That does not look like an SSH public key."));
  try {
    await priv.addKey(target_user, parsed.type, parsed.data, sanitiseLabel(label));
    res.redirect("/keys?msg=" + encodeURIComponent("Key added to " + target_user + "."));
  } catch (e) {
    res.redirect("/keys?err=" + encodeURIComponent(e.message));
  }
});

app.post("/keys/remove", requireAuth, requirePerm("keys.manage"), requireCsrf, async (req, res) => {
  const { target_user, fingerprint } = req.body;
  try {
    await priv.removeKey(target_user, fingerprint);
    db.deleteDeviceByFp(fingerprint);
    res.redirect("/keys?msg=" + encodeURIComponent("Key revoked."));
  } catch (e) {
    res.redirect("/keys?err=" + encodeURIComponent(e.message));
  }
});

function parsePublicKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, data] = parts;
  const allowed = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
  ];
  if (!allowed.includes(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(data)) return null;
  return { type, data, comment: parts.slice(2).join(" ") };
}

function sanitiseLabel(label) {
  const clean = String(label || "").replace(/[^A-Za-z0-9 _.@:+-]/g, "").trim();
  return clean.slice(0, 64) || "added-via-dashboard";
}

/* -------------------------------------------------------------- devices --- */

/**
 * Devices: the browsers signed in to Joya as you (lib/sessions.js). Every
 * signed-in user sees and may sign out their own; no permission is needed.
 * Signing a browser out destroys its session in the store -- its next request
 * lands on the sign-in page -- and ends any live voice call bound to it.
 */
function endCallsFor(sids, why) {
  // Added by the live-voice work; this branch must run without it.
  if (typeof endLiveCallsForSession !== "function") return;
  for (const sid of sids) {
    try {
      endLiveCallsForSession(sid, why);
    } catch (_) {
      /* the session is gone either way */
    }
  }
}

app.get("/devices", requireAuth, (req, res) => {
  res.send(
    views.devices({
      csrf: res.locals.csrf,
      user: ctx(req),
      devices: deviceSessions.listFor(req.me.id, req.sessionID),
      canPair: req.perm.can("keys.pair"),
      flash: req.query.msg || null,
      flashError: req.query.err || null,
    })
  );
});

app.post("/devices/signout-others", requireAuth, requireCsrf, async (req, res) => {
  const sids = deviceSessions.sidsFor(req.me.id, req.sessionID);
  const n = await deviceSessions.destroyMany(sids);
  endCallsFor(sids, "signed out");
  deviceSessions.forget(req.me.id);
  db.logLogin(req.ip, req.me.username, "devices", `signed out ${n} other device${n === 1 ? "" : "s"}`);
  res.redirect("/devices?msg=" + encodeURIComponent(n ? `Signed out ${n} other device${n === 1 ? "" : "s"}.` : "No other device was signed in."));
});

app.post("/devices/:id/signout", requireAuth, requireCsrf, async (req, res) => {
  const sid = deviceSessions.resolve(req.me.id, String(req.params.id));
  if (!sid) return res.redirect("/devices?err=" + encodeURIComponent("That device is no longer signed in."));
  if (sid === req.sessionID)
    return res.redirect("/devices?err=" + encodeURIComponent("This is the device you are using. Sign out from the avatar menu instead."));
  const row = deviceSessions.listFor(req.me.id, req.sessionID).find((d) => d.id === req.params.id);
  try {
    await deviceSessions.destroy(sid);
  } catch (e) {
    return res.redirect("/devices?err=" + encodeURIComponent("Could not sign that device out: " + e.message));
  }
  endCallsFor([sid], "signed out");
  deviceSessions.forget(req.me.id);
  const what = row ? row.label + (row.ip ? " (" + row.ip + ")" : "") : "a device";
  db.logLogin(req.ip, req.me.username, "devices", "signed out " + what);
  res.redirect("/devices?msg=" + encodeURIComponent("Signed out " + (row ? row.label : "that device") + "."));
});

/* -------------------------------------------------------------- pairing --- */

/**
 * Pairing a laptop for SSH lives on SSH keys (card "Pair a device"): a code
 * installs a key, it is not a sign-in. The POST URLs it had under /devices
 * answer 307 so a form still open on an old page keeps working (307 keeps the
 * method and the body, CSRF token included).
 */
app.post("/keys/pair", requireAuth, requirePerm("keys.pair"), requireCsrf, (req, res) => {
  // Crockford-ish base32, no vowels, to avoid ambiguity and accidental words.
  const alphabet = "0123456789BCDFGHJKLMNPQRSTVWXZ";
  let code = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) code += alphabet[bytes[i] % alphabet.length];
  code = code.slice(0, 4) + "-" + code.slice(4, 8) + "-" + code.slice(8, 12);

  const label = sanitiseLabel(req.body.label || "new device");
  const targetUser = req.body.target_user === "root" ? "root" : "ubuntu";
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.createPairingCode(code, label, targetUser, expires);
  db.logLogin(req.ip, req.me.username, "keys", `created a pairing code for "${label}" (${targetUser})`);
  res.redirect("/keys?code=" + encodeURIComponent(code) + "#pair");
});

app.post("/keys/pair/revoke", requireAuth, requirePerm("keys.pair"), requireCsrf, (req, res) => {
  const code = String(req.body.code || "");
  const gone = db.deletePairingCode(code).changes;
  if (gone) db.logLogin(req.ip, req.me.username, "keys", "revoked a pairing code");
  res.redirect("/keys?msg=" + encodeURIComponent(gone ? "Pairing code revoked." : "That code was already gone.") + "#pair");
});

app.post("/devices/code", (req, res) => res.redirect(307, "/keys/pair"));
app.post("/devices/code/revoke", (req, res) => res.redirect(307, "/keys/pair/revoke"));

// Deliberately unauthenticated: a brand-new device has no credentials yet.
// Guarded by a single-use, 15-minute, high-entropy code plus rate limiting.
app.get("/pair", pairLimiter, (req, res) => {
  res.send(views.pair({ csrf: res.locals.csrf }));
});

app.post("/pair", pairLimiter, requireCsrf, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const row = db.getPairingCode(code);
  const fail = (msg) => {
    logAuthFailure(req.ip, "pairing: " + msg);
    return res.status(400).send(views.pair({ csrf: res.locals.csrf, error: msg }));
  };

  if (!row) return fail("Unknown or expired pairing code.");
  if (row.used_at) return fail("That pairing code has already been used.");
  if (new Date(row.expires_at) < new Date()) return fail("That pairing code has expired.");

  const parsed = parsePublicKey(req.body.pubkey);
  if (!parsed) return fail("That does not look like an SSH public key.");

  try {
    const result = await priv.addKey(row.target_user, parsed.type, parsed.data, row.label);
    db.consumePairingCode(code, result.fingerprint);
    db.addDevice(row.label, row.target_user, result.fingerprint, req.ip);
    res.send(
      views.paired({
        label: row.label,
        targetUser: row.target_user,
        fingerprint: result.fingerprint,
        publicHost: PUBLIC_HOST,
      })
    );
  } catch (e) {
    return fail(e.message);
  }
});

/* ---------------------------------------------------------------- audit --- */

app.get("/audit", requireAuth, requirePerm("audit.view"), async (req, res) => {
  let entries = [];
  let err = null;
  try {
    entries = await priv.auditTail(200);
  } catch (e) {
    err = e.message;
  }
  res.send(
    views.audit({
      csrf: res.locals.csrf,
      user: ctx(req),
      entries,
      err,
      logins: db.recentLogins(50),
    })
  );
});

/* --------------------------------------------------------------- agents --- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Resolve :slug into a record, or end the response.
 *
 * Every agent and channel route needs the same three things -- a validated
 * slug, the record from the privileged helper, and a 404 that does not leak
 * whether a given slug exists -- so they are done once here.
 */
function loader(fetch) {
  return async function (req, res) {
    const slug = String(req.params.slug || "");
    if (!SLUG_RE.test(slug)) {
      res.status(404).send(views.error("Not found", "No such item."));
      return null;
    }
    try {
      return await fetch(slug);
    } catch (e) {
      res.status(404).send(views.error("Not found", e.message));
      return null;
    }
  };
}

const loadAgent = loader((slug) => priv.agentGet(slug));
const loadChannel = loader((slug) => priv.channelGet(slug));

function redirectTo(base, slug, suffix, params) {
  const query = Object.entries(params || {})
    .filter(([, v]) => v)
    .map(([k, v]) => k + "=" + encodeURIComponent(v))
    .join("&");
  return base + "/" + slug + (suffix || "") + (query ? "?" + query : "");
}

const agentRedirect = (slug, suffix, params) =>
  redirectTo("/agents", slug, suffix, params);
const channelRedirect = (slug, suffix, params) =>
  redirectTo("/channels", slug, suffix, params);

/** Trim a form field to a plain single-line string. */
function field(body, name) {
  return String((body && body[name]) || "").trim();
}

/**
 * The "Send files to chat" switch. An unticked checkbox sends nothing, so the
 * form also carries file_send_shown; without it the answer is `missing`.
 */
function fileSendField(body, missing) {
  if (!body || field(body, "file_send_shown") !== "1") return missing;
  return field(body, "file_send") === "1";
}

/** The "Images (drawn in code)" switch, read the same way as fileSendField. */
function drawingField(body, missing) {
  if (!body || field(body, "drawing_shown") !== "1") return missing;
  return field(body, "drawing") === "1";
}

/** Checkbox groups arrive as a string when one is ticked, an array when several. */
function multi(body, name) {
  const value = body && body[name];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** Keep only ids that exist in the catalogue for that scope. */
function pickAddons(body, scope) {
  const valid = new Set(catalog.byScope(scope).map((a) => a.id));
  const chosen = multi(body, "addons").filter((id) => valid.has(id));
  for (const a of catalog.byScope(scope)) {
    if (a.locked && !chosen.includes(a.id)) chosen.push(a.id);
  }
  return chosen.sort();
}

async function probeQuietly() {
  try {
    return await priv.systemProbe();
  } catch (_) {
    return null;
  }
}

/* Agents & sessions ▸ Overview: the sessions round JOYA AI, the Telegram agents, capabilities. */
app.get("/agents/dashboard", requireAuth, async (req, res) => {
  const seesAgents = req.perm.can("agents.view");
  const seesTeam = req.perm.can("joyaai.use");
  if (!seesAgents && !seesTeam && !req.perm.can("claude.running.view")) return res.status(403).send(views.error("Not allowed", "Your role does not include Agents & sessions."));
  const data = await gather({
    agents: () => (seesAgents ? priv.agentList() : Promise.resolve([])),
    channels: () => (seesAgents ? priv.channelList() : Promise.resolve([])),
    probe: () => (seesAgents ? priv.systemProbe() : Promise.resolve(null)),
    running: () => (req.perm.can("claude.running.view") ? priv.ccRunning() : Promise.resolve(null)),
    memory: () => (req.perm.can("claude.memory.read") ? joyaAiMemoryCounts() : Promise.resolve(null)),
  });
  const team = seesTeam ? await sessionsTeam(req) : null;
  let limits = null;
  if (seesTeam) limits = await joyaai.call("hire-limits", {}, req.me.username).catch(() => null);
  let facts = null;
  try {
    facts = data.memory && data.memory.facts != null ? data.memory.facts : null;
  } catch (_) {
    facts = null;
  }
  res.send(
    agentViews.dashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      agents: scopeAgents(req, data.agents || []),
      channels: scopeChannels(req, data.channels || []),
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || (seesAgents ? data.errors.agents : null) || null,
      team,
      limits,
      facts,
      running: data.running || null,
    })
  );
});

app.get("/agents", requireAuth, requirePerm("agents.view"), async (req, res) => {
  try {
    const agents = scopeAgents(req, await priv.agentList());
    res.send(
      agentViews.list({
        csrf: res.locals.csrf,
        user: ctx(req),
        agents,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list agents", e.message));
  }
});

app.get("/agents/new", requireAuth, requirePerm("agents.create"), async (req, res) => {
  res.send(
    agentViews.create({
      csrf: res.locals.csrf,
      user: ctx(req),
      form: {},
      probe: await probeQuietly(),
    })
  );
});

app.post("/agents/new", requireAuth, requirePerm("agents.create"), requireCsrf, async (req, res) => {
  const addons = pickAddons(req.body, "agent");
  const form = {
    name: field(req.body, "name"),
    slug: field(req.body, "slug").toLowerCase(),
    role: String(req.body.role || "").trim(),
    model: field(req.body, "model") || "claude-opus-5-5",
    effort: field(req.body, "effort") || "medium",
    verbose_level: field(req.body, "verbose_level") || "1",
    project_dir: field(req.body, "project_dir"),
    file_send: fileSendField(req.body, true),
    drawing: drawingField(req.body, true),
    addons,
  };
  const errors = [];
  if (!SLUG_RE.test(form.slug))
    errors.push(
      "Short name must start with a letter and contain only lowercase letters, digits and hyphens."
    );
  if (!form.name) errors.push("A display name is required.");

  if (errors.length) {
    return res.status(400).send(
      agentViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        form,
        errors,
        probe: await probeQuietly(),
      })
    );
  }

  try {
    await priv.agentCreate({
      slug: form.slug,
      name: form.name,
      role: form.role,
      // its bot avatar, from what it does (lib/agent-avatar.js); Settings > Avatar changes it
      avatar: agentAvatar.derive(form.slug, form.role + "\n" + form.name),
      model: form.model,
      effort: form.effort,
      verbose_level: Number(form.verbose_level),
      project_dir: form.project_dir,
      file_send: form.file_send,
      drawing: form.drawing,
      addons,
      addon_env: catalog.envFor(addons, "agent", req.body),
    });
    priv.agentMemoryIndex(form.slug).catch(() => {});
    // Step two of the wizard. Anyone who genuinely wanted only an agent can
    // skip from there, but the default path leads to a working agent rather
    // than a created one, and those are not the same thing.
    res.redirect(
      "/channels/new?wizard=1&agent=" + encodeURIComponent(form.slug)
    );
  } catch (e) {
    return res.status(400).send(
      agentViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        form,
        errors: [e.message],
        probe: await probeQuietly(),
      })
    );
  }
});

app.get("/agents/:slug", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let notes = [];
  try {
    notes = await priv.agentVaultList(agent.slug, "memory");
  } catch (_) {
    /* a vault with no memory/ folder yet is normal, not an error */
  }
  // The journal tail on the overview is the Logs tab's own read -- same
  // helper call, same permission, same redaction -- just fewer lines.
  let journal = null;
  let journalErr = null;
  if (req.perm.canAgent("agents.logs", agent.slug)) {
    try {
      journal = (await priv.agentLogs(agent.slug, 80)).lines;
    } catch (e) {
      journalErr = e.message;
    }
  }
  res.send(
    agentViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      notes,
      journal,
      journalErr,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/action", requireAuth, requirePerm("agents.control"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    await priv.agentAction(agent.slug, field(req.body, "action"));
    res.redirect(
      agentRedirect(agent.slug, "", { msg: "Agent " + field(req.body, "action") + "ed." })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "", { err: e.message }));
  }
});

app.get("/agents/:slug/instructions", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let content = "";
  try {
    content = (await priv.agentReadFile(agent.slug, "CLAUDE.md")).content;
  } catch (_) {
    content = "";
  }
  res.send(
    agentViews.instructions({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      content,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/instructions", requireAuth, requirePerm("agents.edit"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    await priv.agentWriteFile(agent.slug, "CLAUDE.md", String(req.body.content || ""));
    res.redirect(agentRedirect(agent.slug, "/instructions", { msg: "Instructions saved." }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/instructions", { err: e.message }));
  }
});

app.get("/agents/:slug/memory", requireAuth, requirePerm("agents.memory.read"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const query = String(req.query.q || "").slice(0, 500).trim();
  let notes = [];
  let index = null;
  let hits = null;
  let err = req.query.err || null;
  // The organised view reads the whole vault index (notes with their links, files by name);
  // the flat list is the fallback, so the page still lists notes if the index read fails.
  try {
    index = await priv.agentVaultIndex(agent.slug);
  } catch (e) {
    try {
      notes = await priv.agentVaultList(agent.slug);
    } catch (e2) {
      err = e2.message;
    }
  }
  if (query) {
    try {
      hits = await priv.agentMemorySearch(agent.slug, query);
    } catch (e) {
      err = "Search failed: " + e.message;
      hits = [];
    }
  }
  let peers = [];
  try {
    peers = scopeAgents(req, await priv.agentList());
  } catch (_) {
    /* the chips then offer this agent alone */
  }
  res.send(
    agentViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      agents: peers,
      view: String(req.query.view || ""),
      notes,
      index,
      query,
      hits,
      flash: req.query.msg || null,
      err,
    })
  );
});

app.post("/agents/:slug/memory/reindex", requireAuth, requirePerm("agents.memory.write"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    const stats = await priv.agentMemoryIndex(agent.slug, true);
    res.redirect(
      agentRedirect(agent.slug, "/memory", {
        msg: "Reindexed: " + stats.files + " files, " + stats.chunks + " chunks.",
      })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

app.get("/agents/:slug/memory/note", requireAuth, requirePerm("agents.memory.read"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const path = String(req.query.path || "");
  try {
    const file = await priv.agentReadFile(agent.slug, path);
    // The vault index gives the note's links in and out; without it the note still reads.
    let index = null;
    try {
      index = await priv.agentVaultIndex(agent.slug);
    } catch (_) {
      index = null;
    }
    res.send(
      agentViews.note({
        csrf: res.locals.csrf,
        user: ctx(req),
        agent,
        path,
        index,
        mode: String(req.query.mode || ""),
        content: file.content,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

app.post("/agents/:slug/memory/note", requireAuth, requirePerm("agents.memory.write"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const path = field(req.body, "path");
  try {
    await priv.agentWriteFile(agent.slug, path, String(req.body.content || ""));
    res.redirect(
      "/agents/" +
        agent.slug +
        "/memory/note?path=" +
        encodeURIComponent(path) +
        "&msg=" +
        encodeURIComponent("Note saved. It will be re-indexed on the next search.")
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

/**
 * The overview's journal tail, refreshed in place. The same permission and the
 * same redacting helper call as the Logs page; JSON so a lapsed session gets a
 * status code rather than a sign-in form in the middle of the panel.
 */
app.get("/api/agents/:slug/logs", async (req, res) => {
  if (!req.me) return res.status(401).json({ error: "Sign in first." });
  if (!req.perm.can("agents.logs")) return res.status(403).json({ error: "Your role does not include agent logs." });
  const slug = String(req.params.slug || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return res.status(404).json({ error: "No such agent." });
  try {
    const lines = (await priv.agentLogs(slug, 80)).lines;
    res.json({ html: agentViews.journalHtml(lines), count: lines.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/agents/:slug/logs", requireAuth, requirePerm("agents.logs"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let lines = [];
  let err = null;
  try {
    lines = (await priv.agentLogs(agent.slug, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    agentViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      lines,
      err,
    })
  );
});

app.get("/agents/:slug/settings", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  // Settings > Avatar > Shuffle: another avatar in the same theme, shown until "Use this" stores it.
  const candidate =
    req.query.avatar === "shuffle" && req.perm.canAgent("agents.edit", agent.slug)
      ? agentAvatar.shuffle(agent.slug, agentAvatar.roleText(agent), agentAvatar.specFor(agent))
      : null;
  res.send(
    agentViews.settings({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      candidate,
      probe: await probeQuietly(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

/* Settings > Avatar > Use this: the avatar shown, checked against the lists, into agent.json (no restart). */
app.post("/agents/:slug/avatar", requireAuth, requirePerm("agents.edit"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const raw = {};
  for (const k of agentAvatar.KEYS) raw[k] = field(req.body, "avatar_" + k);
  raw.v = Number(raw.v);
  raw.seed = Number(raw.seed);
  const spec = agentAvatar.norm(raw);
  if (!spec) return res.redirect(agentRedirect(agent.slug, "/settings", { err: "That avatar is not one this panel makes. Shuffle again." }));
  try {
    await priv.agentAvatar(agent.slug, spec);
    res.redirect(agentRedirect(agent.slug, "/settings", { msg: "Avatar saved. The agent was not restarted." }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/settings", { err: e.message }));
  }
});

/* The agent's avatar as a file of its own: ?theme=light|dark, ?px=64..1024, ?download=1 to save it. */
app.get("/agents/:slug/avatar.svg", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const theme = req.query.theme === "dark" ? "dark" : "light";
  const px = Math.max(64, Math.min(1024, parseInt(req.query.px, 10) || 640));
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-cache");
  if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="${agent.slug}-avatar.svg"`);
  res.send(agentAvatar.svg(agentAvatar.specFor(agent), { standalone: theme, px }));
});

app.post("/agents/:slug/settings", requireAuth, requirePerm("agents.edit"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const addons = pickAddons(req.body, "agent");
  try {
    const result = await priv.agentUpdate({
      slug: agent.slug,
      name: field(req.body, "name"),
      role: agent.role || "",
      model: field(req.body, "model"),
      effort: field(req.body, "effort") || "medium",
      verbose_level: Number(field(req.body, "verbose_level") || 1),
      max_turns: Number(field(req.body, "max_turns") || 100),
      timeout_seconds: Number(field(req.body, "timeout_seconds") || 1800),
      project_dir: field(req.body, "project_dir"),
      // undefined (form without the switch) leaves the stored value alone
      file_send: fileSendField(req.body, undefined),
      drawing: drawingField(req.body, undefined),
      addons,
      addon_env: catalog.envFor(addons, "agent", req.body),
    });
    const moved = result && result.api_port_moved;
    const msg = moved
      ? `Settings saved. Port ${moved.asked} is used by another agent, so this agent's webhook API stays on port ${moved.port}.`
      : "Settings saved.";
    res.redirect(agentRedirect(agent.slug, "/settings", { msg }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/settings", { err: e.message }));
  }
});

app.post("/agents/:slug/delete", requireAuth, requirePerm("agents.delete"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  if (field(req.body, "confirm") !== agent.slug)
    return res.redirect(
      agentRedirect(agent.slug, "/settings", {
        err: "Type the agent's short name exactly to confirm deletion.",
      })
    );
  try {
    const result = await priv.agentDelete(agent.slug);
    res.redirect(
      "/agents?msg=" +
        encodeURIComponent(agent.slug + " stopped and archived to " + result.archived_to + ".")
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/settings", { err: e.message }));
  }
});

/* ------------------------------------------------------------- channels --- */

app.get("/channels", requireAuth, requirePerm("channels.view"), async (req, res) => {
  const data = await gather({
    channels: () => priv.channelList(),
    agents: () => priv.agentList(),
  });
  res.send(
    channelViews.list({
      csrf: res.locals.csrf,
      user: ctx(req),
      channels: scopeChannels(req, data.channels),
      agents: scopeAgents(req, data.agents),
      flash: req.query.msg || null,
      err: req.query.err || data.errors.channels || null,
    })
  );
});

/**
 * Resolve the agent a wizard step is continuing from.
 *
 * Returns null unless `?wizard=1` names an agent that exists and is in scope,
 * so a forged link cannot make the page claim an agent was just created.
 */
async function wizardAgent(req, agents) {
  if (!req.query.wizard) return null;
  const slug = String(req.query.agent || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return null;
  const match = (agents || []).find((a) => a.slug === slug);
  return match ? { slug: match.slug, name: match.name } : null;
}

app.get("/channels/new", requireAuth, requirePerm("channels.create"), async (req, res) => {
  let agents = [];
  try {
    agents = scopeAgents(req, await priv.agentList());
  } catch (_) {
    /* rendering the form with no agents is still useful */
  }
  res.send(
    channelViews.create({
      csrf: res.locals.csrf,
      user: ctx(req),
      agents,
      wizard: await wizardAgent(req, agents),
      form: { agent: req.query.agent || "" },
    })
  );
});

app.post("/channels/new", requireAuth, requirePerm("channels.create"), requireCsrf, async (req, res) => {
  const type = field(req.body, "type") === "whatsapp" ? "whatsapp" : "telegram";
  const addons = pickAddons(req.body, "channel");
  const form = {
    name: field(req.body, "name"),
    slug: field(req.body, "slug").toLowerCase(),
    type,
    agent: field(req.body, "agent"),
    allowed_users: field(req.body, "allowed_users").replace(/\s/g, ""),
    allowed_numbers: field(req.body, "allowed_numbers").replace(/\s/g, ""),
    topics_enabled: !!req.body.topics_enabled,
    topics_chat_id: field(req.body, "topics_chat_id"),
    addons,
  };
  const topicsForm = topics.parseTopicsForm(req.body);
  const token = String(req.body.token || "").trim();
  const errors = [];
  if (type === "telegram") errors.push(...topics.checkTopics(topicsForm));

  if (!SLUG_RE.test(form.slug))
    errors.push(
      "Short name must start with a letter and contain only lowercase letters, digits and hyphens."
    );
  if (!form.name) errors.push("A channel name is required.");
  if (type === "telegram" && !telegram.looksLikeToken(token))
    errors.push("That does not look like a bot token. It should read 8123456789:AA…");

  const rerender = async (extra = [], botInfo = null) => {
    let agents = [];
    try {
      agents = scopeAgents(req, await priv.agentList());
    } catch (_) {
      /* ignore */
    }
    return res.status(400).send(
      channelViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        agents,
        wizard: await wizardAgent({ query: { wizard: req.body.wizard, agent: form.agent }, perm: req.perm }, agents),
        form,
        errors: errors.concat(extra),
        botInfo,
      })
    );
  };

  if (errors.length) return rerender();

  let bot = null;
  if (type === "telegram") {
    // Verify before writing anything. A token Telegram rejects is the most
    // common way a new channel ends up silently dead, and finding out here
    // costs one API call instead of a trip through the logs.
    try {
      bot = await telegram.getMe(token);
    } catch (e) {
      return rerender(["Telegram rejected that token: " + e.message]);
    }
    if (form.topics_enabled && !req.body.ignore_telegram_warnings) {
      try {
        const check = await telegram.checkGroup(token, form.topics_chat_id);
        if (check.problems.length) {
          return rerender(
            check.problems.concat([
              "Fix these in Telegram and submit again, or untick topics to use a private chat.",
            ]),
            bot
          );
        }
      } catch (e) {
        return rerender(["Could not check that group: " + e.message], bot);
      }
    }
  }

  try {
    const created = await priv.channelCreate({
      slug: form.slug,
      name: form.name,
      type,
      agent: form.agent,
      token,
      telegram_bot_username: bot ? bot.username : "",
      allowed_users: form.allowed_users,
      allowed_numbers: form.allowed_numbers,
      ...topics.topicsPayload(topicsForm),
      addons,
      addon_env: catalog.envFor(addons, "channel", req.body),
    });
    // The channel exists either way; a Topics setting that did not start was
    // switched off by the helper, which says why.
    const topicsNote = created && created.topics_error ? " " + created.topics_error : "";
    // Finishing the wizard lands on the agent, not the channel: the thing you
    // set out to build was an agent that works, and its page is where you
    // check that it does.
    if (req.body.wizard && form.agent) {
      return res.redirect(
        agentRedirect(form.agent, "", {
          msg:
            "Agent and channel are ready." +
            (bot ? " Say hello to @" + bot.username + " on Telegram." : "") +
            topicsNote,
        })
      );
    }

    const msg = (form.agent
      ? "Channel created and connected." +
        (bot ? " Say hello to @" + bot.username + " on Telegram." : "")
      : "Channel created. Connect it to an agent to bring it to life.") + topicsNote;
    res.redirect(channelRedirect(form.slug, "", { msg }));
  } catch (e) {
    return rerender([e.message], bot);
  }
});

app.get("/channels/:slug", requireAuth, requirePerm("channels.view"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  let agents = [];
  try {
    agents = await priv.agentList();
  } catch (_) {
    /* ignore */
  }
  // The QR is only meaningful for a WhatsApp channel that is mid-link, and it
  // expires in about a minute, so it is fetched per request rather than cached.
  let wa = null;
  if (channel.type === "whatsapp") {
    try {
      wa = await priv.waStatus(channel.slug);
    } catch (_) {
      /* the bridge may not be installed; the view handles that */
    }
  }
  // The folders a topic may map to (inside the connected agent's folder), and
  // the proposed default list for a channel that has none yet.
  let topicFolders = null;
  if (channel.type === "telegram" && channel.agent) {
    try {
      topicFolders = await priv.channelTopicsFolders(channel.slug);
    } catch (_) {
      /* the view falls back to a plain text field */
    }
  }
  res.send(
    channelViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      channel,
      agents,
      wa,
      topicFolders,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

/**
 * The bridge's live state, for the linking page to poll.
 *
 * WhatsApp rotates its pairing code every twenty seconds. A code rendered when
 * the page loaded is dead long before anyone has found Linked Devices on their
 * phone, which is why linking appeared not to work at all: the mechanism was
 * fine and the picture was stale. The page now asks for the current one.
 */
app.get("/channels/:slug/whatsapp/status", requireAuth, requirePerm("channels.view"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  if (channel.type !== "whatsapp") return res.status(404).json({ error: "Not a WhatsApp channel." });

  try {
    const wa = await priv.waStatus(channel.slug);
    res.set("Cache-Control", "no-store").json({
      status: wa.status || "stopped",
      linked: !!wa.linked,
      qr: wa.qr || null,
      number: (wa.me && wa.me.number) || null,
      active: (wa.unit && wa.unit.active) || "inactive",
      updated_at: wa.updated_at || null,
      last_error: wa.last_error || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/channels/:slug/whatsapp/link", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  try {
    await priv.waLink(channel.slug);
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg: "Bridge started. The QR code appears here within a few seconds — reload if it is not shown yet.",
      })
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

app.post("/channels/:slug/whatsapp/unlink", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  try {
    const result = await priv.waUnlink(channel.slug);
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg:
          "Unlinked. The device session was archived to " +
          (result.archived_to || "the archive") +
          "; scan a new code to reconnect.",
      })
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

app.get("/channels/:slug/logs", requireAuth, requirePerm("channels.logs"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  let lines = [];
  let err = null;
  try {
    lines = (await priv.waLogs(channel.slug, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    serviceViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      unit: "joya-whatsapp@" + channel.slug,
      lines,
      err,
    })
  );
});

app.post("/channels/:slug", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const token = String(req.body.token || "").trim();
  const addons = pickAddons(req.body, "channel");

  const update = {
    slug: channel.slug,
    name: field(req.body, "name"),
    type: channel.type,
    agent: field(req.body, "agent"),
    // Membership is deliberately absent. It is edited by the /members routes,
    // and the helper preserves any key the payload omits -- whereas an empty
    // string overrides the stored list. This form no longer carries those
    // fields, so posting them would have emptied the allow-list, silently,
    // every time somebody renamed a channel or changed an add-on.
    addons,
    addon_env: catalog.envFor(addons, "channel", req.body),
  };

  const bail = (msg) => res.redirect(channelRedirect(channel.slug, "", { err: msg }));
  if (channel.type === "telegram") {
    const t = topics.parseTopicsForm(req.body);
    const problems = topics.checkTopics(t);
    if (problems.length) return bail("Topics not saved: " + problems.join(" "));
    Object.assign(update, topics.topicsPayload(t));
    const r = topics.parseRespondForm(req.body);
    const rProblems = topics.checkRespond(r);
    if (r.has_respond && rProblems.length) return bail("Not saved: " + rProblems.join(" "));
    Object.assign(update, topics.respondPayload(r));
  }

  if (token) {
    if (!telegram.looksLikeToken(token))
      return bail("That does not look like a bot token.");
    try {
      const bot = await telegram.getMe(token);
      update.telegram_bot_username = bot.username;
      update.token = token;
    } catch (e) {
      return bail("Telegram rejected that token: " + e.message);
    }
  }
  try {
    const saved = await priv.channelUpdate(update);
    const check = saved && saved.topics_check;
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg:
          "Channel saved." +
          (check && check.ok
            ? check.state === "slow"
              ? (update.topics_enabled ? " Topics are on; the" : " The") + " bot is still starting, so check its log in a minute."
              : update.topics_enabled
                ? " Topics are on and the bot started in topic mode."
                : " The bot started with the new settings."
            : ""),
      })
    );
  } catch (e) {
    return bail(e.message);
  }
});

/**
 * Telegram Topics ▸ Trash: put a deleted topic's folder back in topics/, or
 * delete it now. The helper checks the path against the bot's own list
 * (projects.auto.json) under its lock; this only refuses the obviously wrong.
 */
app.post("/channels/:slug/topics/trash", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const op = field(req.body, "op");
  const trashPath = field(req.body, "trash_path");
  const back = (params) => res.redirect(channelRedirect(channel.slug, "", params));
  if (channel.type !== "telegram" || !channel.agent) return back({ err: "This channel has no topic folders." });
  if (!["restore", "delete"].includes(op)) return back({ err: "Unknown action." });
  if (!/^\.trash\/topics\/[^/\\\x00-\x1f]{1,120}$/.test(trashPath)) return back({ err: "That is not a folder in the trash." });
  try {
    const r = await priv.channelTopicsTrash(channel.slug, op, trashPath);
    back({
      msg: op === "restore"
        ? "Folder restored to " + ((r && r.path) || "topics/") + ". A new topic with its name is linked to it again."
        : "Folder deleted.",
    });
  } catch (e) {
    back({ err: e.message });
  }
});

app.post("/channels/:slug/delete", requireAuth, requirePerm("channels.delete"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  if (field(req.body, "confirm") !== channel.slug)
    return res.redirect(
      channelRedirect(channel.slug, "", {
        err: "Type the channel's short name exactly to confirm deletion.",
      })
    );
  try {
    const result = await priv.channelDelete(channel.slug);
    res.redirect(
      "/channels?msg=" +
        encodeURIComponent(channel.slug + " archived to " + result.archived_to + ".")
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

/* ------------------------------------------------------------- services --- */

/* Machine ▸ Services: tabs All / System (services.view) and Agents (agents.view; was /services/agents). */
app.get("/services", requireAuth, async (req, res) => {
  const seesSvc = req.perm.can("services.view");
  const seesAgents = req.perm.can("agents.view");
  if (!seesSvc && !seesAgents) return res.status(403).send(views.error("Not allowed", "Your role does not include services."));
  let kind = ["all", "system", "agents"].includes(req.query.kind) ? req.query.kind : seesSvc ? "all" : "agents";
  if (kind === "agents" && !seesAgents) kind = "all";
  if (kind !== "agents" && !seesSvc) kind = "agents";
  const flash = req.query.msg || null;
  const err = req.query.err || null;
  try {
    if (kind === "agents") {
      const agents = scopeAgents(req, await priv.agentList());
      return res.send(serviceViews.agents({ csrf: res.locals.csrf, user: ctx(req), agents, flash, err, counts: { agents: agents.length } }));
    }
    const list = await priv.serviceList();
    primeFrame(req, list);
    const services = chrome.visibleServices(list, req.perm);
    const system = services.filter((s) => !serviceViews.isAgentUnit(s));
    res.send(
      serviceViews.system({
        csrf: res.locals.csrf,
        user: ctx(req),
        services: kind === "system" ? system : services,
        kind,
        counts: { all: services.length, system: system.length },
        flash,
        err,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list services", e.message));
  }
});

app.post("/services/action", requireAuth, requirePerm("services.control"), requireCsrf, async (req, res) => {
  const unit = field(req.body, "target");
  const action = field(req.body, "action");
  try {
    await priv.serviceAction(unit, action);
    res.redirect("/services?msg=" + encodeURIComponent(unit + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services?err=" + encodeURIComponent(e.message));
  }
});

app.get("/services/logs", requireAuth, requirePerm("services.logs"), async (req, res) => {
  const unit = String(req.query.unit || "");
  let lines = [];
  let err = null;
  try {
    lines = (await priv.serviceLogs(unit, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    serviceViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      unit,
      lines,
      err,
    })
  );
});

/* ---------------------------------------------------------------- firewall - */

app.get("/firewall", requireAuth, requirePerm("firewall.view"), async (req, res) => {
  try {
    const status = await priv.firewallStatus();
    res.send(
      firewallViews.index({
        csrf: res.locals.csrf,
        user: ctx(req),
        status,
        myIp: req.ip,
        canManage: req.perm.can("firewall.manage"),
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not read the firewall", e.message));
  }
});

app.post("/firewall/ban", requireAuth, requirePerm("firewall.manage"), requireCsrf, async (req, res) => {
  const ip = field(req.body, "ip");
  const note = field(req.body, "note");
  try {
    // The helper decides whether this address may be blocked, and req.ip is the
    // half of that decision only the server knows. `trust proxy` is loopback, so
    // this is the real client address and not nginx.
    const done = await priv.firewallBan({ ip, note, requester: req.ip });
    db.logLogin(req.ip, req.me.username, "firewall", "blocked " + done.ip);
    res.redirect("/firewall?msg=" + encodeURIComponent(done.ip + " is blocked."));
  } catch (e) {
    res.redirect("/firewall?err=" + encodeURIComponent(e.message));
  }
});

app.post("/firewall/unban", requireAuth, requirePerm("firewall.manage"), requireCsrf, async (req, res) => {
  const ip = field(req.body, "ip");
  try {
    const done = await priv.firewallUnban(ip);
    db.logLogin(req.ip, req.me.username, "firewall", "unblocked " + done.ip);
    res.redirect(
      "/firewall?msg=" +
        encodeURIComponent(done.ip + " unblocked (" + done.cleared.join(", ") + ").")
    );
  } catch (e) {
    res.redirect("/firewall?err=" + encodeURIComponent(e.message));
  }
});

// What was Agents ▸ Agent services is Machine ▸ Services ▸ Agents.
app.get("/services/agents", requireAuth, (req, res) => {
  const q = new URLSearchParams({ kind: "agents" });
  if (req.query.msg) q.set("msg", String(req.query.msg));
  if (req.query.err) q.set("err", String(req.query.err));
  res.redirect(302, "/services?" + q.toString());
});

app.post("/services/agent-action", requireAuth, requirePerm("agents.control"), requireCsrf, async (req, res) => {
  const slug = field(req.body, "target");
  const action = field(req.body, "action");
  // Scope is re-checked here because the slug arrives in the body rather than
  // the path, so requireAgentScope never sees it.
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug))
    return res.redirect("/services?kind=agents&err=" + encodeURIComponent("Unknown agent."));
  try {
    await priv.agentAction(slug, action);
    res.redirect("/services?kind=agents&msg=" + encodeURIComponent(slug + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services?kind=agents&err=" + encodeURIComponent(e.message));
  }
});

/* --------------------------------------------------------- openai voice --- */

/**
 * The voice's configuration, key included, held in this process's memory.
 *
 * It lives in a root-only file the helper owns; reading it costs a sudo call,
 * so it is cached, and dropped the moment Settings changes it. The key never
 * leaves this object: routes get voicePublic(), which has no key in it, and
 * nothing here logs it.
 */
let voiceCache = { at: 0, cfg: null, pending: null };
const VOICE_TTL_MS = 5 * 60 * 1000;

/**
 * Drop the cached voice settings. `live` says what happens to open live
 * calls: "close" (the key was removed: nothing to talk with), "keep" (a test
 * of what is on disk: nothing changed), or "reconnect" (a new key or new voice
 * settings: every call reconnects its upstream with them and goes on -- see
 * voiceReconnect). A live call is never dropped for a change it can survive.
 */
function voiceForget(live) {
  voiceCache = { at: 0, cfg: null, pending: null };
  voice.clearCache();
  voiceShared.closeAll(); // a changed key or voice must not keep a summariser open on the old one
  if (live === "close") voiceLive.closeAll("settings-changed");
}
/** After voiceForget("reconnect"): every open live call reconnects with the settings now on disk. */
async function voiceReconnect(greetActor) {
  if (!voiceLive.activeCount()) return [];
  const cfg = await voiceConfig();
  if (!cfg.key) {
    voiceLive.closeAll("settings-changed");
    return [];
  }
  const out = await voiceLive.swapAll(liveCfgOf(cfg), greetActor);
  out.forEach((r) => console.log(`live: ${r.actor}'s call ${r.ok ? "reconnected" : "could not reconnect"} after a voice settings change${r.ms != null ? " (" + r.ms + " ms)" : ""}`));
  return out;
}
/**
 * A voice.set the administrator confirmed (UI control Phase 3): while its
 * confirm is open the voice is locked -- no other change of voice gets in --
 * and once taken, the options post that applies it may greet in the new voice.
 */
const voiceGreet = new Map(); // actor -> until (ms): their confirmed voice.set is being applied
/** Is a voice.set waiting for anyone's confirm? (The voice is global.) */
function uiConfirmsVoicePending() {
  return uiConfirms.anyPending("voice.set");
}

/**
 * Voice on or off, for everyone: one switch (JOYA AI ▸ Settings ▸ Voice). A
 * panel setting, not a secret, so it lives in the panel's database -- in the
 * key the front desk's three-way mode used ("voice_desk"), with new values:
 *   "on"   voice is live conversation, for those who may use it (voice.use)
 *   "off"  no voice at all: no microphone, no read-aloud, no live call, and
 *          JOYA AI's voice screen actions are refused. The key stays stored.
 * The old values map onto them when read (0 -> off; 1 and live -> on), and are
 * rewritten once at start (migrateVoiceSetting), so a downgrade reads "on" /
 * "off" as its own "off" (an unknown value) -- never as voice on.
 */
const VOICE_SETTING = "voice_desk";
function voiceSettingValue(raw) {
  const v = String(raw == null ? "" : raw).trim();
  return v === "on" || v === "1" || v === "live" ? "on" : "off";
}
function voiceEnabled() {
  try {
    return voiceSettingValue(db.getSetting(VOICE_SETTING, "off")) === "on";
  } catch (_) {
    return false;
  }
}
/** The one-time rewrite of the old values (idempotent: on / off / unset are left alone). */
function migrateVoiceSetting() {
  try {
    const raw = db.getSetting(VOICE_SETTING, null);
    if (raw === null || raw === undefined || raw === "on" || raw === "off") return null;
    const now = voiceSettingValue(raw);
    db.setSetting(VOICE_SETTING, now, "migration");
    console.log(`voice: the voice setting ${JSON.stringify(String(raw).slice(0, 10))} became "${now}" (voice is live conversation only)`);
    return now;
  } catch (e) {
    console.log("voice: could not migrate the voice setting: " + e.message);
    return null;
  }
}
migrateVoiceSetting();
/** May this actor talk to JOYA AI by voice (administrators by default)? */
function voiceAllowed(perm) {
  return !!(perm && perm.can && perm.can("joyaai.use") && perm.can("voice.use"));
}
/**
 * The voice model (Settings ▸ Voice): the live call's realtime model, and the
 * model that reads replies aloud when it passed the verbatim check
 * (lib/voice.js READER_MODELS; any other choice is read by
 * gpt-realtime-2.1-mini: readerModelFor). What the administrator said is
 * written down by gpt-4o-transcribe on the realtime models (lib/voice-transcribe.js;
 * the Transcription setting was removed on 2026-10-30) and by GPT-Live itself on
 * GPT-Live. A panel setting; the helper's file holds the reader model, the
 * voice and the live session's transcription model, rewritten to match on every
 * save and once at start (migrateVoiceHelperModels).
 */
const VOICE_MODEL_SETTING = "voice_model";
/**
 * The chosen voice model, as stored (a VOICE_MODELS id). A gated model the key
 * is KNOWN not to reach (voiceAccess below) gives the default instead, so a
 * call never starts on a model OpenAI will refuse; not known yet keeps the
 * choice (it was available when it was saved).
 */
function voiceModel() {
  try {
    const v = db.getSetting(VOICE_MODEL_SETTING, "");
    if (!voice.VOICE_MODELS.some((m) => m.id === v)) return voice.VOICE_MODEL_DEFAULT;
    const a = voiceModelAccess()[v];
    return a && a.known && !a.available ? voice.VOICE_MODEL_DEFAULT : v;
  } catch (_) {
    return voice.VOICE_MODEL_DEFAULT;
  }
}
/** The id the live call connects with: a gated model's listed id or dated snapshot, else the model itself. */
function voiceLiveModelId(model) {
  const a = voiceModelAccess()[model];
  return (a && a.use) || model;
}
/**
 * Which voice models the key reaches (lib/voice.js modelAccess): its free
 * /v1/models listing, read at start, after the key changes, when Settings ▸
 * Voice is opened with an answer older than VOICE_ACCESS_TTL_MS (in the
 * background), and before a gated model is saved. Only ids are kept. So
 * GPT-4o Mini Realtime enables itself once the key gains it.
 */
// (The two env values exist for the tests: tools/test-voice-models.cjs.)
const VOICE_ACCESS_TTL_MS = Number(process.env.JOYA_VOICE_ACCESS_TTL_MS) >= 0 && process.env.JOYA_VOICE_ACCESS_TTL_MS ? Number(process.env.JOYA_VOICE_ACCESS_TTL_MS) : 6 * 60 * 60 * 1000;
const VOICE_ACCESS_RECHECK_MS = Number(process.env.JOYA_VOICE_ACCESS_RECHECK_MS) >= 0 && process.env.JOYA_VOICE_ACCESS_RECHECK_MS ? Number(process.env.JOYA_VOICE_ACCESS_RECHECK_MS) : 60 * 1000;
let voiceAccess = { at: 0, ids: null, error: null, pending: null };
function voiceModelAccess() {
  return voice.modelAccess(voiceAccess.ids);
}
function checkVoiceAccess(opts) {
  const force = !!(opts && opts.force);
  if (!force && voiceAccess.at && Date.now() - voiceAccess.at < VOICE_ACCESS_TTL_MS) return Promise.resolve(voiceAccess);
  if (voiceAccess.pending) return voiceAccess.pending;
  const pending = voiceConfig()
    .then((cfg) => {
      if (!cfg.key) return { ids: null, error: "no token" };
      return voice.listModels({ key: cfg.key, httpBase: process.env.JOYA_OPENAI_HTTP || undefined }).then(
        (ids) => ({ ids, error: null }),
        (e) => ({ ids: null, error: priv.redact(String(e.message || e)) })
      );
    })
    .catch((e) => ({ ids: null, error: priv.redact(String(e.message || e)) }))
    .then((r) => {
      const was = JSON.stringify(voiceModelAccess());
      // A failed check keeps the last good listing (a blip must not disable a working choice).
      voiceAccess = { at: Date.now(), ids: r.ids || voiceAccess.ids, error: r.error, pending: null };
      if (r.error) console.log("voice: could not list the key's models: " + r.error);
      if (JSON.stringify(voiceModelAccess()) !== was) voiceCache = { at: 0, cfg: null, pending: null };
      return voiceAccess;
    });
  voiceAccess.pending = pending;
  return pending;
}
/**
 * The voice model setting, cleaned once at start. Idempotent: nothing stored
 * or a value in VOICE_MODELS is left alone -- gpt-realtime-mini and GPT-4o
 * Mini Realtime are choices again (2026-10-01), so the rewrite of 2026-09-30
 * that turned them into gpt-realtime-2.1-mini no longer happens; only an
 * unknown value (gpt-realtime, gpt-live-1, junk) becomes the default. The
 * helper's file is rewritten only when it differs (and holds a key).
 */
function migrateVoiceModelSetting() {
  try {
    const raw = db.getSetting(VOICE_MODEL_SETTING, null);
    if (raw === null || raw === undefined || raw === "" || voice.VOICE_MODELS.some((m) => m.id === raw)) return null;
    const now = voice.VOICE_MODEL_DEFAULT;
    db.setSetting(VOICE_MODEL_SETTING, now, "migration");
    console.log(`voice: the voice model ${JSON.stringify(String(raw).slice(0, 40))} is not offered; it became "${now}"`);
    return now;
  } catch (e) {
    console.log("voice: could not migrate the voice model: " + e.message);
    return null;
  }
}
async function migrateVoiceHelperModels() {
  try {
    const d = await priv.voiceKeyRead();
    if (!d || !d.key) return null; // nothing stored yet: the first save writes the pair
    const model = voiceModel();
    const reader = voice.readerModelFor(model);
    const listen = voiceTranscribe.sessionModelFor();
    // The voice is kept as chosen when it is one the panel knows (a GPT-Live-only voice included).
    const name = voice.VOICES.includes(d.voice) ? d.voice : voice.DEFAULTS.voice;
    if (d.model === reader && d.transcribe_model === listen && d.voice === name) return null;
    await priv.voiceOptionsSet(reader, name, listen);
    voiceCache = { at: 0, cfg: null, pending: null };
    console.log(`voice: the helper's voice options became ${reader} / ${name} / ${listen} (were ${String(d.model || "-").slice(0, 40)} / ${String(d.transcribe_model || "-").slice(0, 40)})`);
    return { reader, listen };
  } catch (e) {
    console.log("voice: could not migrate the helper's voice options: " + priv.redact(String(e.message || e)));
    return null;
  }
}
migrateVoiceModelSetting();

/*
 * Transcription was a Settings choice from 2026-09-30 to 2026-10-30 (setting
 * "voice_transcription"). It is gpt-4o-transcribe now, fixed
 * (lib/voice-transcribe.js): a stored value is left in the database and
 * ignored, so nothing it names can fail. The local whisper.cpp server
 * (joya-voice-whisper.service) is no longer started from here.
 */
/**
 * How live conversation handles the speaker (a panel setting, JSON):
 *   duplex  "speakers" (half-duplex: the microphone is not heard while the
 *           voice speaks; the default) | "full" (headphones: talk over it).
 *           Each browser can override it from the live bar (remembered there).
 *   noise   OpenAI's input noise reduction: "far_field" (laptop microphone,
 *           the default) | "near_field" (headset) | "off".
 */
const VOICE_LIVE_AUDIO_SETTING = "voice_live_audio";
function liveAudio() {
  let v = {};
  try {
    v = JSON.parse(db.getSetting(VOICE_LIVE_AUDIO_SETTING, "") || "{}") || {};
  } catch (_) {
    v = {};
  }
  return {
    duplex: voiceLive.DUPLEX.includes(v.duplex) ? v.duplex : "speakers",
    noise: voiceLive.NOISE_REDUCTION.includes(v.noise) ? v.noise : "far_field",
  };
}

/**
 * What the voice costs, recorded here from the real usage OpenAI reports for
 * every call -- the live call's audio, its summaries, every sentence spoken --
 * per voice turn and per kind of turn (lib/voice-usage.js). Shown in the
 * Command Center's Cost today card. No cap (the administrator's decision of
 * 2026-09-29): the voice is never refused for what it has spent (the daily
 * token caps in Usage & budget are separate).
 */
const voiceLedger = voiceUsage.createLedger({ insert: (r) => db.voiceUsageInsert(r), rowsSince: (ms) => db.voiceUsageSince(ms) });
function voiceUsageSummary() {
  try {
    return voiceLedger.summary();
  } catch (e) {
    return { error: e.message };
  }
}
/** Record priced calls; a failure to record never fails the voice. */
function recordVoice(fn) {
  try {
    return fn() || 0;
  } catch (e) {
    console.log("voice usage: could not record: " + e.message);
    return 0;
  }
}
/** Speech billing now, and the late part (cut readings) when it lands. */
function recordSpeech({ vt, cat, actor, billing, lateBilling }) {
  const usd = recordVoice(() => voiceLedger.addBilling({ vt, cat, actor, billing }));
  if (lateBilling) lateBilling.then((more) => more && more.length && recordVoice(() => voiceLedger.addBilling({ vt, cat, actor, billing: more })), () => {});
  return usd;
}
function recordTranscription({ vt, actor, heard }) {
  if (!heard || !heard.tokens) return 0;
  return recordVoice(() => voiceLedger.add({ vt, part: "transcription", model: heard.model, tokens: heard.tokens, actor }).usd);
}
function bodyVt(req) {
  return voiceUsage.cleanVt(req.body && req.body.vt);
}

/**
 * How the voice speaks to this user (lib/voice-persona.js): the register and
 * the voice's own gender, learned from how they speak to it and saved on their
 * account. personaHear() reads one utterance and saves (and audits) a change
 * only when the utterance clearly shows one.
 */
function personaOf(userId) {
  try {
    return voicePersona.clean(db.getVoicePersona(userId));
  } catch (_) {
    return voicePersona.clean(null);
  }
}
function personaHear({ userId, username, ip }, text) {
  const saved = personaOf(userId);
  const m = voicePersona.merge(saved, voicePersona.detect(text));
  if (m.changed.length) {
    try {
      db.setVoicePersona(userId, JSON.stringify(m.persona));
      const d = voicePersona.describe(m.persona);
      db.logLogin(ip, username, "voice", `voice persona learned from speech: ${m.changed.map((k) => (k === "dialect" ? "dialect " + d.dialect : "self-gender " + d.gender)).join(", ")}`);
    } catch (e) {
      console.log("voice persona: could not save: " + e.message);
    }
  }
  return m.persona;
}

function ndjson(res) {
  let open = true;
  res.on("close", () => (open = false));
  return {
    start() {
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    },
    write(obj) {
      if (open) res.write(JSON.stringify(obj) + "\n");
    },
    end() {
      if (open) res.end();
    },
  };
}

/** The fields a live call takes from the voice config (a new call, or a reconnect after a change). */
function liveCfgOf(cfg) {
  return { key: cfg.key, voice: cfg.voice, model: cfg.model, live_model: cfg.live_model, transcribe_model: cfg.transcribe_model };
}

async function voiceConfig() {
  if (voiceCache.cfg && Date.now() - voiceCache.at < VOICE_TTL_MS) return voiceCache.cfg;
  if (voiceCache.pending) return voiceCache.pending;
  const pending = priv
    .voiceKeyRead()
    .then((d) => {
      const live = voiceModel();
      const cfg = {
        key: d && d.key ? String(d.key) : null,
        // The voice model talks live; it reads aloud too only when it passed the
        // verbatim check (readerModelFor: otherwise gpt-realtime-2.1-mini reads).
        model: voice.readerModelFor(live),
        live_model: voiceLiveModelId(live),
        voice_model: live,
        // A voice the voice model cannot use (a GPT-Live voice left from before a change to a realtime model) speaks as its stand-in.
        voice: voice.standInFor((d && d.voice) || voice.DEFAULTS.voice, live),
        // The realtime session's own transcription (GPT-Live calls use none).
        transcribe_model: voiceTranscribe.sessionModelFor(),
      };
      if (voiceCache.pending === pending) voiceCache = { at: Date.now(), cfg, pending: null };
      return cfg;
    })
    .catch((e) => {
      if (voiceCache.pending === pending) voiceCache.pending = null;
      return { key: null, ...voice.DEFAULTS, live_model: voiceLiveModelId(voiceModel()), voice_model: voiceModel(), transcribe_model: voiceTranscribe.sessionModelFor(), error: e.message };
    });
  voiceCache.pending = pending;
  return pending;
}

/**
 * What a page may know: whether voice works for this viewer, and with what.
 * Never the key. `on` is the Settings switch; `use` this viewer's voice.use;
 * `live` all of it and a key -- the only case in which any mic, read-aloud or
 * live control is rendered.
 */
async function voicePublic(req) {
  const cfg = await voiceConfig();
  const on = voiceEnabled();
  const use = voiceAllowed(req && req.perm);
  return {
    configured: !!cfg.key,
    model: cfg.voice_model || cfg.live_model,
    voice: cfg.voice,
    provider: "OpenAI",
    manage: !!(req && req.perm && req.perm.can("voice.manage")),
    on,
    use,
    live: !!cfg.key && on && use,
    liveDuplex: liveAudio().duplex,
  };
}
/**
 * The dock's microphone on the other pages (lib/ui.js dockMarkup): shown only
 * when live conversation works for this viewer. The voice settings are cached,
 * so this costs nothing once they have been read; until then (the first page
 * after a restart) it waits for them once.
 */
async function voiceDockOk(req) {
  if (!req.me || !voiceEnabled() || !voiceAllowed(req.perm)) return false;
  const cfg = await voiceConfig();
  return !!cfg.key;
}

/** Voice is off for everyone (Settings ▸ Voice): the refusal a voice route gives. */
function voiceOffRefuse(res) {
  return res.status(409).json({ error: "Voice is off. An administrator can switch it on in JOYA AI ▸ Settings ▸ Voice.", code: "voice-off" });
}

function voiceFail(res, e) {
  const status =
    e.code === "no-key" ? 503 : e.code === "invalid" ? 400 : e.code === "unfaithful" ? 422 : e.code === "timeout" ? 504 : 502;
  res.status(status).json({ error: e.message, code: e.code || "error" });
}

const AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]{1,30}$/;

/**
 * The transcripts this server produced, per user and voice turn: a voice send
 * to JOYA AI must be one of them (see /joya-ai/api/send). In memory only; a
 * restart just means a voice turn in flight is said again.
 */
const voiceGrounds = new voiceGuard.Grounds();


/**
 * One line per voice call in the journal: outcome, model, timings, sizes.
 * Never the key, never what was said -- counts only.
 */
function voiceLog(kind, status, f) {
  const parts = ["voice", kind, String(status)];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(k + "=" + (k === "why" ? JSON.stringify(voice.scrub(String(v)).slice(0, 120)) : v));
  }
  console.log(parts.join(" "));
}

/**
 * One sentence in, its audio out.
 *
 * Streamed (Accept: application/x-ndjson, what the Command Center asks for):
 * one JSON object a line, as OpenAI produces the reading --
 *   {type:"start", engine, rate}  a reading begins
 *   {type:"audio", pcm}           PCM16 mono 24 kHz, base64
 *   {type:"cut", why}             the reading failed the verbatim check (or
 *                                 broke) mid-way: stop it and drop what came
 *                                 since its start; a start from the fallback
 *                                 (gpt-4o-mini-tts, which reads verbatim)
 *                                 follows and reads the sentence from its start
 *   {type:"end", engine, fallback, cached} | {type:"skipped", why} | {type:"error"}
 * Whole (anything else, e.g. the console): a WAV -- or 204 when the voice
 * would not read it as written.
 *
 * Body: {text, vt?, cat?} -- vt ties the sentence to a voice turn and cat says
 * what kind (the direct path by default), for the usage figures.
 */
async function voiceSpeakRoute(req, res) {
  if (!voiceEnabled()) return voiceOffRefuse(res);
  const text = typeof (req.body && req.body.text) === "string" ? req.body.text : "";
  if (!text.trim()) return res.status(400).json({ error: "Nothing to say.", code: "invalid" });
  const t0 = Date.now();
  const words = text.split(/\s+/).filter(Boolean).length;
  const vt = bodyVt(req);
  const cat = voiceUsage.cleanCat(req.body && req.body.cat) || "direct";
  const actor = req.me && req.me.username;
  const streamed = /application\/x-ndjson/.test(String(req.get("accept") || ""));
  let cfg = null;
  if (streamed) {
    const out = ndjson(res);
    let started = false;
    const write = (o) => {
      if (!started) {
        out.start();
        started = true;
      }
      out.write(o);
    };
    let aborted = false;
    res.on("close", () => (aborted = !res.writableEnded));
    let bytes = 0;
    try {
      cfg = await voiceConfig();
      const r = await voice.speakStream(text, cfg, {
        start: ({ engine }) => write({ type: "start", engine, rate: voice.RATE }),
        audio: (b) => {
          bytes += b.length;
          write({ type: "audio", pcm: b.toString("base64") });
        },
        cut: ({ why }) => {
          bytes = 0;
          write({ type: "cut", why });
        },
      });
      const usd = recordSpeech({ vt, cat, actor, billing: r.billing, lateBilling: r.lateBilling });
      voiceLog("speak", 200, {
        engine: r.cached ? undefined : r.engine,
        ms: Date.now() - t0,
        first_audio_ms: r.firstAudioMs,
        warm: r.cached ? undefined : r.warm ? 1 : 0,
        cached: r.cached ? 1 : undefined,
        fallback: r.fallback ? r.why || "unfaithful" : undefined,
        cuts: r.cuts || undefined,
        audio_s: Math.round((bytes / (voice.RATE * 2)) * 100) / 100,
        words,
        streamed: 1,
        aborted: aborted ? 1 : undefined,
        usd: usd ? usd.toFixed(6) : undefined,
      });
      write({ type: "end", engine: r.cached ? "cache" : r.fallback ? "fallback" : "realtime", fallback: !!r.fallback, cached: !!r.cached });
      out.end();
    } catch (e) {
      if (e.billing) recordSpeech({ vt, cat, actor, billing: e.billing, lateBilling: e.lateBilling });
      voiceLog("speak", e.code === "unfaithful" ? 204 : e.code || "error", { model: cfg && cfg.model, ms: Date.now() - t0, words, streamed: 1, why: e.message });
      if (!started && e.code !== "unfaithful") return voiceFail(res, e);
      // Unfaithful and no fallback: skipped -- the sentence stays on screen.
      write(e.code === "unfaithful" ? { type: "skipped", why: "unfaithful" } : { type: "error", error: voice.scrub(e.message), code: e.code || "error" });
      out.end();
    }
    return;
  }
  try {
    cfg = await voiceConfig();
    const out = await voice.speak(text, cfg);
    const usd = recordSpeech({ vt, cat, actor, billing: out.billing, lateBilling: out.lateBilling });
    voiceLog("speak", 200, {
      engine: out.engine || cfg.model,
      ms: Date.now() - t0,
      first_audio_ms: out.firstAudioMs,
      warm: out.cached ? undefined : out.warm ? 1 : 0,
      cached: out.cached ? 1 : undefined,
      fallback: out.fallback ? out.why || "unfaithful" : undefined,
      audio_s: Math.round(((out.wav.length - 44) / (voice.RATE * 2)) * 100) / 100,
      words,
      usd: usd ? usd.toFixed(6) : undefined,
    });
    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": String(out.wav.length),
      "Cache-Control": "no-store",
      "X-Voice-Engine": out.fallback ? "fallback" : out.cached ? "cache" : "realtime",
    });
    res.send(out.wav);
  } catch (e) {
    if (e.billing) recordSpeech({ vt, cat, actor, billing: e.billing, lateBilling: e.lateBilling });
    voiceLog("speak", e.code === "unfaithful" ? 204 : e.code || "error", { model: cfg && cfg.model, ms: Date.now() - t0, words, why: e.message });
    // Not an error to the page: the sentence is skipped, and it stays on screen.
    // With the text-to-speech fallback this should now be rare; the page says so when it happens.
    if (e.code === "unfaithful") return res.status(204).set({ "X-Voice-Skipped": "unfaithful", "Cache-Control": "no-store" }).end();
    voiceFail(res, e);
  }
}

/* JOYA AI ▸ Settings ▸ Voice (/joya-ai/settings/voice): the section and its
   forms. The key is write-only: it is posted once, handed to the helper on
   stdin into the same root-only file, and from then on the panel only says
   whether it is set. Every form answers os.js in place (JSON with the note)
   and a plain POST with a redirect back to the row. */

const voiceSettingsViews = require("./lib/views-settings-voice");
let vprint = null; // lib/voiceprint.js, made below (see "the voiceprint")

/** The Voiceprint group's data for Settings ▸ Voice. */
async function voiceprintView(me) {
  if (!vprint) return null;
  if (vprint.enabled()) await vprint.health(true).catch(() => null);
  await vprint.openAll().catch(() => {});
  return { ...vprint.status(me), stats: vprint.stats(7), presets: voiceprintLib.PRESETS, bounds: voiceprintLib.BOUNDS, users: db.listUsers ? db.listUsers().map((u) => ({ id: u.id, username: u.username })) : [] };
}

async function voiceSettings() {
  try {
    return await priv.voiceStatus();
  } catch (e) {
    return { error: e.message, configured: false, ...voice.DEFAULTS };
  }
}

/** Answer a voice form: settingsRoutes' reply, plus {message|error} for the Command Center's confirmed changes. */
function voiceReply(req, res, { msg, err, anchor, reload } = {}) {
  if (settingsRoutes.wantsJson(req)) {
    const { flashes } = require("./lib/ui");
    return res.status(err ? 400 : 200).json({ ok: !err, flash: flashes({ msg, err }), reload: !!reload, ...(err ? { error: err } : { message: msg || "" }) });
  }
  return settingsRoutes.reply(req, res, "voice", { msg, err, anchor, reload });
}
/** Signed in, JOYA AI and voice.manage (the section's own rule), then the CSRF token. */
function voiceSettingsPerm(req, res, next) {
  if (req.perm.can("joyaai.use") && req.perm.can("voice.manage")) return next();
  if (settingsRoutes.wantsJson(req)) return res.status(403).json({ ok: false, error: "This account cannot change voice settings." });
  return requirePerm("voice.manage")(req, res, next);
}
const voiceGuardSettings = [requireAuth, voiceSettingsPerm, requireCsrf];

settingsRoutes.sections.voice = async (req, res) => {
  const on = voiceEnabled();
  // Which voice models the key reaches: a stale answer is refreshed in the background (the next visit shows it).
  checkVoiceAccess().catch(() => {});
  const [status, cfg] = await Promise.all([voiceSettings(), voiceConfig()]);
  const test = req.query.test ? { ok: req.query.test === "ok", text: String(req.query.t || "").slice(0, 600) } : null;
  const vmodel = cfg.voice_model || cfg.live_model;
  return {
    body: voiceSettingsViews.body({
      csrf: res.locals.csrf,
      on,
      status: status.error ? { configured: !!cfg.key } : status,
      model: vmodel,
      models: voice.VOICE_MODELS,
      access: voiceModelAccess(),
      voice: cfg.voice,
      // The cards offer what the voice model can use (GPT-Live 31, the realtime models 10).
      voices: voice.voicesFor(vmodel),
      meta: voice.VOICE_META,
      liveAudio: liveAudio(),
      test,
      voiceprint: await voiceprintView(req.me),
    }),
    secClass: on ? "" : "voice-off",
    assets: ["joya-settings-voice.css", "joya-settings-voice.js"],
  };
};
settingsRoutes.marks.push(async () => ({ voice: voiceEnabled() ? "on" : "off" }));

/*
 * The old /credentials/openai-voice URLs (bookmarks, the Guide, the page
 * registry until it is rescanned): a page GET goes to the section (302);
 * a form POST keeps its method and body and goes to its new route (308), so
 * an old form or a Command Center still running the old script keeps working.
 * The desk switch is gone: its POST lands on the section with a note.
 */
app.get("/credentials/openai-voice", requireAuth, (req, res) => res.redirect(302, "/joya-ai/settings/voice"));
for (const k of ["key", "clear", "test", "options", "persona", "live-audio"]) {
  app.post("/credentials/openai-voice/" + k, (req, res) => res.redirect(308, "/joya-ai/settings/voice/" + k));
}
app.post("/credentials/openai-voice/desk", requireAuth, (req, res) =>
  res.redirect(303, "/joya-ai/settings/voice?msg=" + encodeURIComponent("The voice front desk is gone: voice is live conversation, switched on or off here."))
);

/** The switch: voice on or off, for everyone. Off ends every open live call; the key is kept. */
app.post("/joya-ai/settings/voice/enabled", ...voiceGuardSettings, (req, res) => {
  const want = req.body.enabled === "1" || req.body.enabled === "on" ? "on" : "off";
  const was = voiceEnabled() ? "on" : "off";
  db.setSetting(VOICE_SETTING, want, req.me.username);
  let closed = 0;
  if (want === "off") {
    closed = voiceLive.activeCount();
    voiceLive.closeAll("disabled");
    voiceShared.closeAll();
  }
  db.logLogin(req.ip, req.me.username, "voice", `voice ${want === "on" ? "enabled" : "disabled"} for everyone${was === want ? " (unchanged)" : ""}${closed ? ` (${closed} live call(s) ended)` : ""}`);
  voiceReply(req, res, {
    msg: want === "on" ? "Voice is on: live conversation, for those whose role includes it." : "Voice is off for everyone. The token stays stored." + (closed ? ` ${closed} live call${closed === 1 ? "" : "s"} ended.` : ""),
    anchor: "v-main",
    reload: true,
  });
});

app.post("/joya-ai/settings/voice/key", ...voiceGuardSettings, async (req, res) => {
  const value = String((req.body && req.body.value) || "").trim();
  try {
    const out = await priv.voiceKeySet(value);
    voiceForget("reconnect");
    voiceReconnect(null).catch(() => {});
    checkVoiceAccess({ force: true }).catch(() => {}); // a new key may reach other models
    db.logLogin(req.ip, req.me.username, "voice", "set the OpenAI voice key (…" + out.last4 + ")");
    voiceReply(req, res, { msg: "Token saved. Press Test to check it.", anchor: "v-token", reload: true });
  } catch (e) {
    voiceReply(req, res, { err: priv.redact(e.message), anchor: "v-token" });
  }
});

app.post("/joya-ai/settings/voice/clear", ...voiceGuardSettings, async (req, res) => {
  try {
    await priv.voiceKeyClear();
    voiceForget("close");
    db.logLogin(req.ip, req.me.username, "voice", "removed the OpenAI voice key");
    voiceReply(req, res, { msg: "Token removed. Voice stays off until a new one is added.", anchor: "v-token", reload: true });
  } catch (e) {
    voiceReply(req, res, { err: priv.redact(e.message), anchor: "v-token" });
  }
});

/**
 * The voice model and the voice. Each Settings row posts only its own field; a
 * confirmed voice.set from the Command Center posts the voice. The voice model
 * is the panel's setting (the live call); the helper keeps the reader's
 * model (readerModelFor: the same model when verified, else 2.1 mini), the voice and the live session's transcription
 * model (gpt-4o-transcribe: sessionModelFor). A `transcribe_model` or
 * `transcriber` field (an older page) is ignored: there is one transcription model.
 *
 * The voices depend on the model (lib/voice.js voicesFor): a voice posted for a
 * model that cannot use it is refused; a model change that leaves the stored
 * voice unusable stores its stand-in (standInFor: same presentation), says so,
 * and reloads the section so the cards show the new model's voices.
 */
app.post("/joya-ai/settings/voice/options", ...voiceGuardSettings, async (req, res) => {
  const cur = await voiceConfig();
  const has = (k) => typeof (req.body && req.body[k]) === "string" && req.body[k] !== "";
  const vmodel = has("model") ? field(req.body, "model") : cur.voice_model || voiceModel();
  const entry = voice.VOICE_MODELS.find((m) => m.id === vmodel);
  // The voice as stored in the helper's file (cur.voice may already be a stand-in for the current model).
  let storedVoice = cur.voice;
  try {
    const d = await priv.voiceKeyRead();
    if (d && voice.VOICES.includes(d.voice)) storedVoice = d.voice;
  } catch (_) {
    /* the cached one */
  }
  let name = has("voice") ? field(req.body, "voice") : storedVoice;
  if (!entry || !voice.VOICES.includes(name)) {
    return voiceReply(req, res, { err: "Pick a voice model and a voice from the lists.", anchor: has("model") ? "v-model" : "v-voice" });
  }
  if (has("voice") && !voice.voicesFor(vmodel).includes(name)) {
    return voiceReply(req, res, { err: `${entry.label} cannot speak with ${name}: that voice is GPT-Live's own. Pick one of the voices shown.`, anchor: "v-voice" });
  }
  // A model that cannot use the stored voice: its stand-in, said in the reply.
  let swapped = null;
  if (!voice.voicesFor(vmodel).includes(name)) {
    swapped = { from: name, to: voice.standInFor(name, vmodel) };
    name = swapped.to;
  }
  const cardsChange = has("model") && voice.voicesFor(vmodel).length !== voice.voicesFor(cur.voice_model || voiceModel()).length;
  // A gated model is saved only when the key's model list carries it (checked
  // again now unless the answer is under VOICE_ACCESS_RECHECK_MS old), so a live call never
  // starts on a model OpenAI will refuse.
  if (entry.gated && vmodel !== voiceModel()) {
    if (!voiceModelAccess()[vmodel].available && Date.now() - voiceAccess.at >= VOICE_ACCESS_RECHECK_MS) await checkVoiceAccess({ force: true });
    if (!voiceModelAccess()[vmodel].available) {
      return voiceReply(req, res, {
        err: `${entry.label} is not available on this OpenAI key${voiceAccess.error ? " (the model list could not be read: " + voiceAccess.error + ")" : ""}. The voice model is unchanged.`,
        anchor: "v-model",
      });
    }
  }
  // The voice is locked while someone's confirm for a voice.set is open (their confirm applies it).
  const lock = uiConfirmsVoicePending();
  if (lock) return voiceReply(req, res, { err: "A voice change is waiting for a confirm on the Command Center; answer that first.", anchor: "v-voice" });
  try {
    const reader = voice.readerModelFor(vmodel);
    const listen = voiceTranscribe.sessionModelFor();
    await priv.voiceOptionsSet(reader, name, listen);
    // Compared with what is stored too: a stored gated model that is out of reach reads as the default.
    const stored = db.getSetting(VOICE_MODEL_SETTING, "") || "";
    if (vmodel !== voiceModel() || (stored && stored !== vmodel)) db.setSetting(VOICE_MODEL_SETTING, vmodel, req.me.username);
    voiceForget("reconnect");
    const greet = (voiceGreet.get(req.me.username) || 0) > Date.now() ? req.me.username : null;
    voiceGreet.delete(req.me.username);
    // Open live calls reconnect with the new settings and go on; the one whose confirm this is says a line in it.
    voiceReconnect(greet).catch(() => {});
    db.logLogin(req.ip, req.me.username, "voice", `voice settings ${vmodel} (live; read-aloud ${reader}; the call's own transcription ${listen}) / ${name}${swapped ? ` (stand-in for ${swapped.from}, which ${vmodel} cannot use)` : ""}${voiceLive.activeCount() ? ` (${voiceLive.activeCount()} live call(s) reconnect with it)` : ""}`);
    const what =
      (has("model") && !has("voice") ? `Voice model: ${vmodel}.${reader !== vmodel ? ` Replies are read aloud by ${reader}, which reads word for word.` : ""}` : has("voice") && !has("model") ? `Voice: ${name}.` : "Voice settings saved.") +
      (swapped ? ` ${entry.label} cannot use ${swapped.from}, so the voice is now ${swapped.to}.` : "");
    voiceReply(req, res, { msg: what, anchor: has("model") && !has("voice") ? "v-model" : "v-voice", reload: cardsChange || !!swapped });
  } catch (e) {
    voiceReply(req, res, { err: e.message, anchor: "v-voice" });
  }
});

/*
 * The voice persona, set by a confirmed persona.set from the Command Center (a
 * screen action JOYA AI's voice may ask for): a preset from a fixed list
 * (lib/voice-persona.js PRESETS) or "learned" -- never typed. The Settings row
 * ("Arabic", with its Reset) was removed on 2026-10-30 at the administrator's
 * request; without a choice the persona is learned from how they speak. Per
 * user.
 */
app.post("/joya-ai/settings/voice/persona", ...voiceGuardSettings, (req, res) => {
  const preset = field(req.body, "preset");
  const p = voicePersona.choose(preset);
  if (!p) return voiceReply(req, res, { err: "Choose one of the voice personas." });
  const was = voicePersona.describe(personaOf(req.me.id));
  db.setVoicePersona(req.me.id, p.mode === "explicit" ? JSON.stringify(p) : "");
  const now = voicePersona.describe(p);
  db.logLogin(req.ip, req.me.username, "voice", `voice persona set to "${now.choice}" (was "${was.choice}")`);
  voiceReply(req, res, { msg: p.mode === "explicit" ? `Voice persona: ${now.choice}. Arabic replies use it from the next utterance; English stays English.` : "Voice persona: learned from how you speak again." });
});

/** Speaker handling and noise reduction (each row posts its own field; the other is kept). */
app.post("/joya-ai/settings/voice/live-audio", ...voiceGuardSettings, (req, res) => {
  const was = liveAudio();
  const duplex = req.body && req.body.duplex !== undefined ? field(req.body, "duplex") : was.duplex;
  const noise = req.body && req.body.noise !== undefined ? field(req.body, "noise") : was.noise;
  if (!voiceLive.DUPLEX.includes(duplex) || !voiceLive.NOISE_REDUCTION.includes(noise)) {
    return voiceReply(req, res, { err: "Choose speakers or headphones, and a noise reduction.", anchor: "v-live-audio" });
  }
  db.setSetting(VOICE_LIVE_AUDIO_SETTING, JSON.stringify({ duplex, noise }), req.me.username);
  db.logLogin(req.ip, req.me.username, "voice", `live conversation audio: ${duplex === "speakers" ? "speakers mode" : "headphones mode"}, noise reduction ${noise} (was ${was.duplex}, ${was.noise})`);
  voiceReply(req, res, { msg: "Live conversation audio saved. It applies to the next call; each browser can still switch from the live bar.", anchor: "v-live-audio" });
});

/**
 * Test: one short line spoken by the voice model -- the reader JOYA AI's
 * replies are read with -- and transcribed back by gpt-4o-transcribe.
 * A real call; a passing Test shows the model reads aloud word for word.
 */
app.post("/joya-ai/settings/voice/test", ...voiceGuardSettings, async (req, res) => {
  voiceForget("keep"); // test what is on disk now, not a cached copy; open calls are not touched
  let ok = false;
  let text;
  try {
    const cfg = await voiceConfig();
    const out = await voice.check({ ...cfg, model: cfg.live_model }, { transcribe: voiceTranscribe.transcribeFull });
    ok = out.faithful && !!out.heard;
    const fb = out.heard_fallback;
    text =
      `${out.model} (${out.voice}) spoke ${out.seconds != null ? out.seconds + " s of audio " : ""}in ${out.speak_ms} ms` +
      (out.faithful ? ", word for word" : `, but not as written — it said “${out.speak_transcript}”`) +
      (out.heard != null
        ? `; transcription by ${out.heard_by}${fb ? ` (${fb.from} failed: ${fb.why}, so it fell back)` : ""} heard “${out.heard}” in ${out.transcribe_ms} ms.`
        : ".");
  } catch (e) {
    text = e.message;
  }
  text = priv.redact(voice.scrub(text));
  db.logLogin(req.ip, req.me.username, "voice", "tested the OpenAI voice key: " + (ok ? "ok" : "failed"));
  if (settingsRoutes.wantsJson(req)) return voiceReply(req, res, ok ? { msg: "Test passed. " + text } : { err: "Test failed. " + text });
  res.redirect(303, "/joya-ai/settings/voice?test=" + (ok ? "ok" : "fail") + "&t=" + encodeURIComponent(text) + "#v-main");
});

/**
 * A voice card's play button (Settings ▸ Voice): a very short line in THAT
 * voice, spoken by the voice model that holds the call -- GPT-Live for its own
 * voices and the ten it shares, the realtime model otherwise -- so it sounds as
 * the voice does on a call. It neither selects the voice nor touches the form.
 * Each clip is made once per (model, voice, line) and kept on disk
 * (VOICE_SAMPLE_DIR, 0600 files), so a repeat play costs nothing; a made clip's
 * spend is recorded (voice_usage, category "sample"). Refused while voice is
 * off, without a key, or for a voice the current model cannot use.
 * Returns audio/wav.
 */
const VOICE_SAMPLE_LINE = "Hi, I'm JOYA AI.";
const VOICE_SAMPLE_DIR = path.join(DATA_DIR, "voice-samples");
const voiceSampleMaking = new Map(); // file -> promise, so two clicks make one clip
function voiceSampleFile(model, name) {
  const h = crypto.createHash("sha256").update(VOICE_SAMPLE_LINE).digest("hex").slice(0, 10);
  return path.join(VOICE_SAMPLE_DIR, `${String(model).replace(/[^a-z0-9.-]/gi, "_")}__${name}__${h}.wav`);
}
app.post("/joya-ai/settings/voice/sample", ...voiceGuardSettings, async (req, res) => {
  const fail = (status, error, code) => res.status(status).json({ ok: false, error, code });
  if (!voiceEnabled()) return fail(409, "Voice is off. Switch it on to hear a sample.", "voice-off");
  const cfg = await voiceConfig();
  if (!cfg.key) return fail(503, "Add an OpenAI key first.", "no-key");
  const vmodel = cfg.voice_model || voiceModel();
  const name = field(req.body, "voice");
  if (!voice.voicesFor(vmodel).includes(name)) return fail(400, "That voice is not offered for the current voice model.", "invalid");
  // GPT-Live speaks the sample itself (its listed id); a realtime model likewise.
  const model = cfg.live_model || vmodel;
  const file = voiceSampleFile(model, name);
  try {
    const wav = fs.readFileSync(file);
    res.setHeader("Cache-Control", "no-store");
    return res.type("audio/wav").send(wav);
  } catch (_) {
    /* not made yet */
  }
  let making = voiceSampleMaking.get(file);
  if (!making) {
    making = (async () => {
      const out = await voice.speak(VOICE_SAMPLE_LINE, { key: cfg.key, model, voice: name, attempts: 2, fallback: false, noCache: true, timeoutMs: 20000 });
      const vt = ("smp_" + name).slice(0, 48);
      // A realtime reading reports its tokens; GPT-Live is billed by session time.
      if (voice.protocolFor(model) === "live") recordVoice(() => voiceLedger.add({ vt, cat: "sample", part: "speech", model: "gpt-live-1", tokens: { seconds: Math.round(out.ms) / 1000 }, actor: req.me.username }).usd);
      else recordSpeech({ vt, cat: "sample", actor: req.me.username, billing: out.billing, lateBilling: out.lateBilling });
      fs.mkdirSync(VOICE_SAMPLE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file + ".tmp", out.wav, { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
      voiceLog("sample", "ok", { model, voice: name, ms: out.ms, attempts: out.attempts, bytes: out.wav.length });
      return out.wav;
    })();
    voiceSampleMaking.set(file, making);
    making.then(
      () => voiceSampleMaking.delete(file),
      () => voiceSampleMaking.delete(file)
    );
  }
  try {
    const wav = await making;
    res.setHeader("Cache-Control", "no-store");
    res.type("audio/wav").send(wav);
  } catch (e) {
    for (const b of (e && e.billing) || []) recordVoice(() => voiceLedger.add({ vt: ("smp_" + name).slice(0, 48), cat: "sample", part: "speech", model: b.model, tokens: b.tokens, actor: req.me.username }).usd);
    voiceLog("sample", "failed", { model, voice: name, code: e.code, why: e.message });
    const msg = e.code === "unfaithful" ? "The voice did not say the sample line as written. Try again." : priv.redact(voice.scrub(e.message || "The sample could not be made."));
    fail(e.code === "timeout" ? 504 : 502, msg, e.code || "error");
  }
});

/* ---------------------------------------------------------- credentials --- */

app.get("/credentials", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const data = await gather({
    credentials: () => priv.credentialList(),
    probe: () => priv.systemProbe(),
  });
  const voiceState = req.perm.can("voice.manage") ? { ...(await voiceSettings()), on: voiceEnabled() } : null;
  res.send(
    credentialViews.index({
      csrf: res.locals.csrf,
      user: ctx(req),
      credentials: data.credentials || [],
      probe: data.probe || null,
      voice: voiceState,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.credentials || null,
    })
  );
});

app.get("/credentials/:name", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const name = String(req.params.name || "");
  try {
    const credential = await priv.credentialGet(name);
    const list = await priv.credentialList().catch(() => [credential]);
    res.send(
      credentialViews.detail({
        csrf: res.locals.csrf,
        user: ctx(req),
        credential,
        credentials: list,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(404).send(views.error("Not found", e.message));
  }
});

app.post("/credentials/:name", requireAuth, requirePerm("credentials.edit"), requireCsrf, async (req, res) => {
  const name = String(req.params.name || "");
  const key = field(req.body, "key");
  const value = String(req.body.value || "").trim();
  try {
    await priv.credentialSet(name, key, value);
    res.redirect(
      "/credentials/" +
        encodeURIComponent(name) +
        "?msg=" +
        encodeURIComponent(
          key + " saved. Restart your agents for them to pick it up."
        )
    );
  } catch (e) {
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?err=" + encodeURIComponent(e.message)
    );
  }
});

app.post("/credentials/:name/clear", requireAuth, requirePerm("credentials.edit"), requireCsrf, async (req, res) => {
  const name = String(req.params.name || "");
  const key = field(req.body, "key");
  try {
    await priv.credentialClear(name, key);
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?msg=" + encodeURIComponent(key + " cleared.")
    );
  } catch (e) {
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?err=" + encodeURIComponent(e.message)
    );
  }
});

/* --------------------------------------------------------------- addons --- */

app.get("/addons", requireAuth, requirePerm("addons.view"), async (req, res) => {
  const query = String(req.query.q || "").slice(0, 120).trim();
  const scope = ["agent", "channel"].includes(String(req.query.scope))
    ? String(req.query.scope)
    : "";
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    addonViews.catalogue({
      csrf: res.locals.csrf,
      user: ctx(req),
      query,
      scope,
      results: catalog.search(query, scope || null),
      probe: data.probe || null,
      agents: data.agents || [],
      channels: (data.channels || []).map((c) => ({ ...c, name: c.name || c.slug })),
    })
  );
});

/* -------------------------------------------------------------- console --- */

/*
 * Classic chat was hidden in the 2026-09-30 reorganisation and its code removed
 * on 2026-10-25 (with the console.use / console.full permissions). Every
 * /console URL goes to the Command Center. Its data (console_sessions,
 * console_messages) is kept in the database.
 */
app.all(/^\/console(?:\/|$)/, (req, res) => res.redirect(302, "/joya-ai"));

/* ----------------------------------------------- Windows Hello for approvals --- */
/*
 * Every decision that lets something run needs Windows Hello (or the
 * authenticator code) here, on the server: lib/stepup.js. These are the
 * pieces the routes below share. Deny, Keep and Dismiss never ask.
 */

/** A short, stable fingerprint of what exactly is allowed, for the bind string. */
function stepBindHash(...parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * A supervisor op for a stepped-up request: the step-up rides along as
 * `verified` / `verified_with`, so JOYA AI's own ledger and audit log record
 * how it was approved. A supervisor that does not know those fields yet (the
 * two deploy separately) gets the op without them -- the panel's own audit
 * line still says it.
 */
async function callStepped(req, op, params, opts) {
  const s = req.stepUp;
  const p = s ? { ...params, verified: s.method, verified_with: String(s.with || "").slice(0, 80) } : params;
  try {
    return await joyaai.call(op, p, req.me.username, opts);
  } catch (e) {
    if (s && /unexpected field: verified/.test(String(e && e.message))) return joyaai.call(op, params, req.me.username, opts);
    throw e;
  }
}

/** " with Windows Hello (Laptop)" / " with authenticator code", for the panel's audit lines. */
const steppedWith = (req) => (req.stepUp ? " with " + stepup.label(req.stepUp) : "");

/**
 * Keep an approval card alive while Windows Hello runs: the supervisor moves
 * its expiry to at least 90 s from now (bounded there). Resolves to the new
 * expires_at, or null (an older supervisor, or the card is gone).
 */
async function holdApproval(req, id) {
  try {
    const r = await joyaai.call("approval-hold", { approval_id: id, seconds: 90 }, req.me.username, { timeout: 5000 });
    return (r && r.expires_at) || null;
  } catch (_) {
    return null;
  }
}

/** Refusals of a step-up go to the panel's log like every other sign of a check failing. */
const stepAudit = (req, line) => db.logLogin(req.ip, req.me.username, "step-up", String(line).slice(0, 200));

/** Read the current allow-list of a channel as an ordered array. */
function memberList(channel) {
  const raw = channel.type === "telegram" ? channel.allowed_users : channel.allowed_numbers;
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rewrite a channel's allow-list.
 *
 * Sent through channelUpdate rather than a dedicated helper command so the
 * ordinary path runs: the list is revalidated, the agent's environment is
 * regenerated, and the unit is restarted. A membership change that did not
 * restart the agent would leave the old list in the running process, which is
 * exactly the class of bug that made the credential editor confusing.
 */
async function saveMembers(channel, members) {
  const update = {
    slug: channel.slug,
    name: channel.name,
    type: channel.type,
    agent: channel.agent || "",
    topics_enabled: !!channel.topics_enabled,
    topics_chat_id: channel.topics_chat_id || "",
    addons: channel.addons || [],
    addon_env: channel.addon_env || {},
    telegram_bot_username: channel.telegram_bot_username || "",
  };
  // Only the key this channel type actually uses. Sending the other one as an
  // empty string would clear a list that is not being edited -- which matters
  // if a channel is ever converted between types.
  update[channel.type === "telegram" ? "allowed_users" : "allowed_numbers"] =
    members.join(",");
  await priv.channelUpdate(update);
}

const TELEGRAM_ID_RE = /^\d{4,15}$/;
const PHONE_RE = /^\+?\d{6,20}$/;

/* --------------------------------------------------------------- joya ai --- */

/**
 * JOYA AI: the JSON / SSE API the Command Center page consumes.
 *
 * Everything proxies to the JOYA AI supervisor's unix socket (lib/joyaai.js),
 * which owns the one long-lived root Claude Code session that delegates to the
 * others. One permission, joyaai.use, in no stock role: it reaches a root
 * session that can message every other session on the machine, so it is the
 * administrator's until a role is deliberately given it.
 *
 * API routes answer in JSON, including their refusals -- a page polling for
 * status should get {"error": ...} and a status code, not a login form.
 * Writes take the CSRF token in the JSON body (_csrf) or an X-CSRF-Token
 * header. Every write reaches the supervisor with the panel user as actor, and
 * the supervisor audits it; the panel's own audit gets a line as well.
 */

function requireApiPerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.status(401).json({ error: "Sign in first." });
    if (!req.perm.can(perm)) return res.status(403).json({ error: "Your role does not include JOYA AI." });
    next();
  };
}

function requireApiCsrf(req, res, next) {
  const supplied = (req.body && req.body._csrf) || req.get("x-csrf-token");
  if (!supplied || supplied !== req.session.csrf) {
    return res.status(403).json({ error: "Invalid CSRF token. Reload the page and try again." });
  }
  next();
}

const joyaAiGuard = [requireApiPerm("joyaai.use")];
const joyaAiWrite = [requireApiPerm("joyaai.use"), requireApiCsrf];

function joyaAiFail(res, e) {
  const status =
    e.code === "invalid" ? 400 : e.code === "refused" ? 409 : e.code === "offline" ? 503 : e.code === "timeout" ? 504 : 500;
  res.status(status).json({ error: e.message, code: e.code || "error" });
}

/** Memory counts for the rail. The helper call is slow, so it is cached. */
let joyaAiMemory = { at: 0, data: null, pending: null };
async function joyaAiMemoryCounts() {
  if (joyaAiMemory.data && Date.now() - joyaAiMemory.at < 60000) return joyaAiMemory.data;
  if (joyaAiMemory.pending) return joyaAiMemory.pending;
  joyaAiMemory.pending = priv
    .ccMemoryStats()
    .then((s) => {
      const db = (s && s.db) || {};
      const chunks = db.chunks || {};
      const data = {
        facts: db.facts ? db.facts.current : null,
        chunks: Object.values(chunks).reduce((a, b) => a + (Number(b) || 0), 0) || null,
        sessions: db.sessions_indexed == null ? null : db.sessions_indexed,
        last_ingest: db.last_ingest || null,
        last_facts: db.last_facts || null,
        topics: Array.isArray(db.topics) ? db.topics.slice(0, 6).map((t) => String(t).slice(0, 40)) : [],
        healthy: !!(s && s.health && s.health.ok),
      };
      joyaAiMemory = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((e) => {
      joyaAiMemory.pending = null;
      return { error: e.message };
    });
  return joyaAiMemory.pending;
}

/**
 * Agent counts for the rail: how many, how many running, and on which kinds of
 * channel. Only counts and channel types leave here -- an agent's role text,
 * allowed users and addon settings are the agents pages' business. Cached for
 * a minute like the memory counts, because it is a helper call.
 */
let joyaAiAgents = { at: 0, data: null, pending: null };
async function joyaAiAgentCounts(req) {
  if (!req.perm.can("agents.view")) return null;
  if (!(joyaAiAgents.data && Date.now() - joyaAiAgents.at < 60000)) {
    if (!joyaAiAgents.pending) {
      joyaAiAgents.pending = priv
        .agentList()
        .then((list) => {
          joyaAiAgents = { at: Date.now(), data: Array.isArray(list) ? list : [], pending: null };
          return joyaAiAgents.data;
        })
        .catch((e) => {
          joyaAiAgents.pending = null;
          throw e;
        });
    }
    await joyaAiAgents.pending;
  }
  const mine = scopeAgents(req, joyaAiAgents.data);
  const types = [...new Set(mine.map((a) => a.channel && a.channel.type).filter(Boolean))];
  return {
    total: mine.length,
    active: mine.filter((a) => a.state && a.state.active === "active").length,
    channels: types.map((t) => String(t).slice(0, 20)),
  };
}

/** What the page's voice controls can rely on: whether a key is set, and which voice. */
function joyaAiVoice(req) {
  return voicePublic(req);
}

app.get("/joya-ai", requireAuth, async (req, res) => {
  if (!req.perm.can("joyaai.use")) return requirePerm("joyaai.use")(req, res, () => {});
  res.send(
    joyaAiViews.page({
      csrf: res.locals.csrf,
      user: ctx(req, "console"),
      voice: await joyaAiVoice(req),
      core: req.me.joya_core,
      sessview: req.me.sessions_view,
      botHead: req.me.joya_bot_head,
      botColors: req.me.joya_bot_colors,
      botFace: req.me.joya_bot_face,
      botTeam: req.me.joya_bot_team,
      sound: req.me.joya_sound,
      // The desktop app's render mode: the same page, no page round it (public/joya-desktop.js).
      shell: req.query.shell === "desktop" ? "desktop" : null,
    })
  );
});

/**
 * The JOYA AI core, per person: A (dotted sphere), B (Siri fluid), C (hybrid)
 * or D (mesh, the default since 2026-10-06; lib/db.js migrateCoreDefaultD moved
 * everyone to it once). Saved on the user row (users.joya_core) and written
 * into the Command Center as data-core, so the page paints the right core from
 * its first frame. Two ways to change it, one rule: the Command Center's quick
 * switch (JSON, below) and Account > Appearance (a form, further down; its page
 * script uses the JSON route too). Both need joyaai.use -- someone who cannot
 * open the Command Center has no core to choose -- and both leave an audit
 * line ("account": "JOYA AI core ...").
 */
function setJoyaCore(req, core) {
  const was = joyaLogic.normCore(req.me.joya_core);
  db.setUserJoyaCore(req.me.id, core);
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI core ${was} -> ${core} (${joyaLogic.CORES[core]})${was === core ? " (unchanged)" : ""}`);
}
/**
 * The sessions view round the core, per person: "spheres" (the family of
 * spheres, the default) or "orbit" (the classic dots). Stored and audited like
 * the core (users.sessions_view; "account": "Sessions view ..."), written into
 * the Command Center as data-sessview.
 */
function setSessionsView(req, view) {
  const was = joyaLogic.normSessView(req.me.sessions_view);
  db.setUserSessionsView(req.me.id, view);
  db.logLogin(req.ip, req.me.username, "account", `Sessions view ${was} -> ${view} (${joyaLogic.SESS_VIEWS[view]})${was === view ? " (unchanged)" : ""}`);
}
app.post("/joya-ai/api/prefs/sessions", ...joyaAiWrite, (req, res) => {
  const view = req.body && req.body.view;
  if (!joyaLogic.isSessView(view)) return res.status(400).json({ error: "The sessions view must be spheres or orbit.", code: "invalid" });
  setSessionsView(req, view);
  res.json({ view, name: joyaLogic.SESS_VIEWS[view] });
});

/**
 * Core E ("Bot"), per person: the head style (users.joya_bot_head, one of joyaLogic.BOT_HEADS), the
 * colours (users.joya_bot_colors: a preset, or custom "#rrggbb" picks -- hex only, checked by
 * joyaLogic.checkBotColors) and the face style (users.joya_bot_face, 2026-10-22: smooth / dots /
 * minimal, joyaLogic.BOT_FACES). Stored and audited like the core ("account": "JOYA AI bot head ..." /
 * "JOYA AI bot colours ..." / "JOYA AI bot face ..."), written into the Command Center, the dock and
 * Settings as data-bot-head / data-bot-colors / data-bot-face. Any field may come alone.
 */
function setBotHead(req, head) {
  const was = joyaLogic.normBotHead(req.me.joya_bot_head);
  db.setUserBotHead(req.me.id, head);
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI bot head ${was} -> ${head} (${joyaLogic.BOT_HEADS[head]})${was === head ? " (unchanged)" : ""}`);
}
function setBotFace(req, face) {
  const was = joyaLogic.normBotFace(req.me.joya_bot_face);
  db.setUserBotFace(req.me.id, face);
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI bot face ${was} -> ${face} (${joyaLogic.BOT_FACES[face]})${was === face ? " (unchanged)" : ""}`);
}
function setBotColors(req, colors) {
  const was = joyaLogic.botColorsLine(req.me.joya_bot_colors);
  const now = joyaLogic.botColorsLine(colors);
  db.setUserBotColors(req.me.id, joyaLogic.botColorsJson(colors));
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI bot colours ${was} -> ${now}${was === now ? " (unchanged)" : ""}`);
}
app.post("/joya-ai/api/prefs/bot", ...joyaAiWrite, (req, res) => {
  const b = req.body || {};
  if (b.head === undefined && b.colors === undefined && b.face === undefined) return res.status(400).json({ error: "Send a head, colours or a face.", code: "invalid" });
  if (b.head !== undefined && !joyaLogic.isBotHead(b.head)) return res.status(400).json({ error: "The head must be one of " + Object.keys(joyaLogic.BOT_HEADS).join(", ") + ".", code: "invalid" });
  if (b.face !== undefined && !joyaLogic.isBotFace(b.face)) return res.status(400).json({ error: "The face must be one of " + Object.keys(joyaLogic.BOT_FACES).join(", ") + ".", code: "invalid" });
  let colors = null;
  if (b.colors !== undefined) {
    const c = joyaLogic.checkBotColors(b.colors);
    if (!c.ok) return res.status(400).json({ error: c.error, code: "invalid" });
    colors = c.value;
  }
  if (b.head !== undefined) setBotHead(req, b.head);
  if (b.face !== undefined) setBotFace(req, b.face);
  if (colors) setBotColors(req, colors);
  const me = db.getUser(req.me.id);
  const head = joyaLogic.normBotHead(b.head !== undefined ? b.head : me ? me.joya_bot_head : req.me.joya_bot_head);
  const cur = colors || joyaLogic.normBotColors(me ? me.joya_bot_colors : req.me.joya_bot_colors);
  const face = joyaLogic.normBotFace(b.face !== undefined ? b.face : me ? me.joya_bot_face : req.me.joya_bot_face);
  res.json({ head, headName: joyaLogic.BOT_HEADS[head], face, faceName: joyaLogic.BOT_FACES[face], colors: cur, colorsName: joyaLogic.botColorsLine(cur), close: joyaLogic.botClosePairs(cur) });
});

/*
 * Core E's team (2026-10-20): a session's head is its role's (cc-logic botRole) unless the viewer pins one.
 * POST { name, head } -- head one of the ten, or "" / null to go back to the role's. Stored per person
 * (users.joya_bot_team, JSON {normalised session name: head}, at most 64), audited ("JOYA AI bot head for
 * <session> ...").
 */
app.post("/joya-ai/api/prefs/bot-team", ...joyaAiWrite, (req, res) => {
  const c = joyaLogic.checkBotTeamEdit(req.body);
  if (!c.ok) return res.status(400).json({ error: c.error, code: "invalid" });
  const me = db.getUser(req.me.id) || req.me;
  const team = joyaLogic.normBotTeam(me.joya_bot_team);
  const was = team[c.key] || "auto";
  const ed = joyaLogic.applyBotTeamEdit(team, c.key, c.head);
  if (!ed.ok) return res.status(400).json({ error: ed.error, code: "full" });
  db.setUserBotTeam(req.me.id, joyaLogic.botTeamJson(ed.team));
  const now = c.head || "auto";
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI bot head for "${c.key}" ${was} -> ${now}${was === now ? " (unchanged)" : ""}`);
  res.json({ key: c.key, head: c.head, headName: c.head ? joyaLogic.BOT_HEADS[c.head] : null, team: ed.team });
});

/*
 * JOYA AI's sounds (2026-10-20, public/joya-sound.js): on / off, the volume (0-100) and quiet hours, per
 * person (users.joya_sound, JSON; '' = the defaults). POST any of { on, vol, quiet, from, to }; audited
 * ("JOYA AI sounds ..."). Whether a plain browser plays them is that browser's own switch (localStorage),
 * never stored here.
 */
app.post("/joya-ai/api/prefs/sound", ...joyaAiWrite, (req, res) => {
  const c = joyaSound.checkSoundEdit(req.body);
  if (!c.ok) return res.status(400).json({ error: c.error, code: "invalid" });
  const me = db.getUser(req.me.id) || req.me;
  const was = joyaSound.soundPrefsLine(me.joya_sound);
  const next = joyaSound.applySoundEdit(me.joya_sound, c.edit);
  db.setUserSound(req.me.id, joyaSound.soundPrefsJson(next));
  const now = joyaSound.soundPrefsLine(next);
  db.logLogin(req.ip, req.me.username, "account", `JOYA AI sounds ${was} -> ${now}${was === now ? " (unchanged)" : ""}`);
  res.json({ sound: next, line: now });
});

app.post("/joya-ai/api/prefs/core", ...joyaAiWrite, (req, res) => {
  const core = req.body && req.body.core;
  if (!joyaLogic.isCore(core)) return res.status(400).json({ error: "The core must be D (Mesh) or E (Bot).", code: "invalid" });
  setJoyaCore(req, core);
  res.json({ core, name: joyaLogic.CORES[core] });
});

app.get("/joya-ai/api/status", ...joyaAiGuard, async (req, res) => {
  try {
    res.json(await joyaai.call("status", {}, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/** Everything the page needs on load, in one round trip. */
app.get("/joya-ai/api/overview", ...joyaAiGuard, async (req, res) => {
  const who = req.me.username;
  const [status, sessions, delegations, memory, agents, voiceInfo, missions, decisions, orders, watchers] = await Promise.allSettled([
    joyaai.call("status", {}, who),
    joyaai.call("sessions", {}, who),
    joyaai.call("ledger", { table: "delegations", limit: 30 }, who),
    joyaAiMemoryCounts(),
    joyaAiAgentCounts(req),
    joyaAiVoice(req),
    joyaai.call("missions", { status: "all", limit: 20 }, who),
    joyaai.call("decisions", { status: "open" }, who),
    joyaai.call("orders", {}, who),
    joyaai.call("watchers", {}, who),
  ]);
  const opt = (r, key) => (r.status === "fulfilled" ? r.value[key] : null);
  if (status.status === "rejected") return joyaAiFail(res, status.reason);
  res.json({
    status: status.value,
    sessions: sessions.status === "fulfilled" ? sessions.value : { error: sessions.reason.message },
    timeline: delegations.status === "fulfilled" ? delegations.value.rows : [],
    memory: memory.status === "fulfilled" ? memory.value : { error: memory.reason.message },
    agents: agents.status === "fulfilled" ? agents.value : { error: agents.reason.message },
    voice: voiceInfo.status === "fulfilled" ? voiceInfo.value : { configured: false },
    viewer: { name: req.me.display_name || req.me.username, csrf: res.locals.csrf },
    missions: opt(missions, "missions"),
    decisions: opt(decisions, "decisions"),
    orders: opt(orders, "orders"),
    orders_tz: opt(orders, "tz"),
    telegram: opt(orders, "telegram"),
    watchers: opt(watchers, "watchers"),
  });
});

app.get("/joya-ai/api/sessions", ...joyaAiGuard, async (req, res) => {
  try {
    res.json(await joyaai.call("sessions", {}, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/**
 * Hired sessions (M-6): the administrator keeps / unkeeps one, or retires it
 * (the Command Center's Keep / Retire dialog is the consent). The supervisor
 * refuses both for sessions not hired through JOYA AI, and retire for a kept one.
 */
const cleanSlug = (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(v || "")) ? String(v) : null);
app.post("/joya-ai/api/sessions/:slug/keep", ...joyaAiWrite, async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  const kept = req.body && req.body.kept;
  if (!slug) return res.status(404).json({ error: "No such session." });
  if (typeof kept !== "boolean") return res.status(400).json({ error: "kept must be true or false." });
  try {
    const out = await joyaai.call("session-keep", { slug, kept }, req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ai", `${kept ? "kept" : "unkept"} hired session ${slug}`);
    res.json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
});
// Retiring a session (and with it approving a waiting retire card) needs Windows Hello.
const retireStepUp = (html) =>
  stepup.requireStepUp({
    bind: (req) => (cleanSlug(req.params.slug) ? "retire:" + cleanSlug(req.params.slug) : null),
    what: (req) => `Retire the session ${cleanSlug(req.params.slug)}`,
    audit: stepAudit,
    html,
  });
app.post("/joya-ai/api/sessions/:slug/retire", ...joyaAiWrite, retireStepUp(), async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "No such session." });
  try {
    const params = { slug };
    const note = joyaai.cleanNote(req.body && req.body.note);
    if (note) params.note = note;
    const out = await callStepped(req, "session-retire", params, { timeout: 60000 });
    db.logLogin(req.ip, req.me.username, "joya-ai", `retired hired session ${slug}${steppedWith(req)}`);
    res.json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
});

app.get("/joya-ai/api/memory", ...joyaAiGuard, async (req, res) => {
  res.json(await joyaAiMemoryCounts());
});

app.get("/joya-ai/api/rc", ...joyaAiGuard, async (req, res) => {
  try {
    res.json(await joyaai.call("rc-url", {}, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

app.get("/joya-ai/api/ledger/:table", ...joyaAiGuard, async (req, res) => {
  try {
    const params = joyaai.cleanLedger(req.params.table, req.query || {});
    res.json(await joyaai.call("ledger", params, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/**
 * Live events as Server-Sent Events.
 *
 * A GET, so it carries no CSRF token, which is fine: it changes nothing, and
 * the session cookie is SameSite=strict. `Last-Event-ID` (or ?since=) resumes
 * from the supervisor's ring buffer after a reconnect. X-Accel-Buffering stops
 * nginx holding events back until a buffer fills.
 */
app.get("/joya-ai/api/events", ...joyaAiGuard, (req, res) => {
  const since = joyaai.cleanSince(req.get("last-event-id") || (req.query && req.query.since));
  // This tab's id (sessionStorage): JOYA AI's screen actions reach only the tab that asked.
  const tab = typeof (req.query && req.query.tab) === "string" && uiTab.test(req.query.tab) ? req.query.tab : null;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 20000);
  const stream = { actor: req.me.username, tab, res };
  uiStreams.add(stream);
  const close = joyaai.subscribe(
    since,
    req.me.username,
    (ev) => {
      if (ev.type === "ui") return uiDeliver(ev, req, tab, res); // never written as it came
      const data = JSON.stringify(ev);
      res.write((ev.seq ? `id: ${ev.seq}\n` : "") + `event: ${ev.type}\ndata: ${data}\n\n`);
    },
    (err) => {
      clearInterval(beat);
      if (err) res.write(`event: offline\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  );
  req.on("close", () => {
    clearInterval(beat);
    uiStreams.delete(stream);
    close();
  });
});

/**
 * One of JOYA AI's screen actions (its MCP ui_action, relayed live by the
 * supervisor), as seen by the event stream of one tab. lib/ui-relay.js decides:
 * only the tab whose send minted the token acts on it, once; an event with a
 * token this server never minted (a send forged onto the supervisor's socket)
 * is dropped and audited. call.* act on the administrator's live call here;
 * everything else goes to the tab, which answers through /ui/ack.
 */
function uiDeliver(ev, req, tab, res) {
  const actor = req.me.username;
  const r = uiRelay.route(ev, actor, tab);
  const what = `${String(ev.action || "?").slice(0, 40)}${ev.args && Object.keys(ev.args).length ? " " + JSON.stringify(ev.args).slice(0, 120) : ""}`;
  const ack = (ok, why) => joyaai.call("ui-ack", { nonce: ev.nonce, ok, ...(why ? { why: String(why).slice(0, 200) } : {}) }, actor).catch(() => {});
  if (r.forged) {
    db.logLogin(req.ip, actor, "joya-ui", `dropped a screen action (${what}) whose token this panel never minted`);
    return;
  }
  if (!r.deliver) return;
  // A widget (JOYA AI's ui_widget, the living canvas): checked again and offered unless they keep dismissing its kind.
  if (ev.action === "widget.show") return uiWidgetDeliver(ev, req, res, ack);
  const v = UiActions.validate(ev.action, ev.args || {});
  if (!v.ok) return void ack(false, v.why);
  if (uiVoiceOff(v.action)) return void ack(false, "voice is off");
  // Settings > Screen control > Allow screen actions (per person): off keeps JOYA AI to words.
  if (v.tier === 1 && !settingsRoutes.uiActionsEnabled(db, req.me.id)) return void ack(false, "screen actions are off (the administrator switched them off in Settings > Screen control)");
  if (v.tier === 2) {
    const o = uiConfirmOpen({ username: actor, ip: req.ip, canVoice: req.perm.can("voice.manage") }, v, tab, `JOYA AI (turn ${ev.turn_id})`);
    if (o.error) return void ack(false, o.error);
    res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: v.action, args: v.args, toast: o.question, confirm: o.id, deep: true })}\n\n`);
    return void joyaai.call("ui-ack", { nonce: ev.nonce, ok: true, pending: true }, actor).catch(() => {});
  }
  db.logLogin(req.ip, actor, "joya-ui", `${what} by JOYA AI (turn ${ev.turn_id}), to the tab that asked`);
  if (v.where === "server") {
    const call = voiceLive.callFor(actor);
    if (!call) return void ack(false, "no voice call is open");
    const out = call.deepUi(v);
    return void ack(out.ok, out.why);
  }
  res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: v.action, args: v.args, toast: UiActions.toast(v.action, v.args), deep: true })}\n\n`);
}

/**
 * One of JOYA AI's widgets (its MCP ui_widget, relayed like a screen action) for the tab that asked:
 * the building blocks are checked again here (public/joya-widgets.js), the person's switch for screen
 * actions applies, and a kind they always dismiss is no longer offered (lib/routes-canvas.js) -- JOYA
 * AI is told so and answers in words. The page draws it on the board and answers through /ui/ack.
 */
function uiWidgetDeliver(ev, req, res, ack) {
  const actor = req.me.username;
  if (!settingsRoutes.uiActionsEnabled(db, req.me.id)) return void ack(false, "screen actions are off (the administrator switched them off in Settings > Screen control)");
  const o = canvas.offer(req.me, ev.widget);
  if (!o.ok) {
    db.logLogin(req.ip, actor, "joya-ui", `widget.show by JOYA AI (turn ${ev.turn_id}) not offered: ${String(o.why).slice(0, 160)}`);
    return void ack(false, o.why);
  }
  db.logLogin(req.ip, actor, "joya-ui", `widget.show ${o.key} "${o.value.title.slice(0, 80)}" by JOYA AI (turn ${ev.turn_id}), to the tab that asked`);
  res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: "widget.show", args: {}, widget: o.value, key: o.key, turn_id: ev.turn_id, toast: "JOYA AI added a widget: " + o.value.title, deep: true })}\n\n`);
}

/**
 * The page's decision on a Tier-2 confirm: {id, decision: "confirm"|"cancel"}.
 * Hands the pending action over once (a click, or after a heard yes); the page
 * then applies it through the existing CSRF'd route, under this session's
 * permissions. For voice.set it also gets the current model and listening
 * model, so the existing form route keeps them.
 */
app.post("/joya-ai/api/ui/confirm", ...joyaAiWrite, async (req, res) => {
  const b = req.body || {};
  if (typeof b.id !== "string" || !/^[0-9a-f]{18}$/.test(b.id) || (b.decision !== "confirm" && b.decision !== "cancel")) return res.status(400).json({ error: "Bad confirm." });
  const t = uiConfirms.take(req.me.username, b.id, b.decision);
  if (!t) return res.status(404).json({ error: "That confirm has expired.", code: "expired" });
  const what = `${t.action} ${JSON.stringify(t.args)}`;
  if (t.cancelled) {
    db.logLogin(req.ip, req.me.username, "joya-ui", `${what} cancelled`);
    return res.json({ ok: true, cancelled: true });
  }
  if ((t.action === "persona.set" || t.action === "voice.set") && !req.perm.can("voice.manage")) return res.status(403).json({ error: "This account cannot change voice settings." });
  if (uiVoiceOff(t.action)) return res.status(409).json({ error: "Voice is off.", code: "voice-off" });
  let form = null;
  if (t.action === "persona.set") form = { preset: t.args.preset };
  if (t.action === "voice.set") {
    // Only the voice: the voice model and the listening model are kept (Settings ▸ Voice options).
    form = { voice: t.args.voice };
    // Its options post reconnects the open live calls; this user's call says a line in the new voice.
    voiceGreet.set(req.me.username, Date.now() + 20000);
  }
  db.logLogin(req.ip, req.me.username, "joya-ui", `${what} confirmed (${t.spoken ? "spoken yes" : "click"}); the page applies it`);
  res.json({ ok: true, action: t.action, args: t.args, form, done: UiActions.doneText(t.action, t.args) });
});

/** The tab's answer to one of JOYA AI's screen actions: done, or refused and why. */
app.post("/joya-ai/api/ui/ack", ...joyaAiWrite, async (req, res) => {
  const b = req.body || {};
  if (typeof b.nonce !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(b.nonce) || typeof b.ok !== "boolean") return res.status(400).json({ error: "Bad answer." });
  if (!uiRelay.takeAck(b.nonce, req.me.username)) return res.status(404).json({ error: "No such screen action is waiting." });
  try {
    const why = typeof b.why === "string" ? b.why.replace(/[\u0000-\u001f]/g, " ").slice(0, 200) : "";
    res.json(await joyaai.call("ui-ack", { nonce: b.nonce, ok: b.ok, ...(why ? { why } : {}) }, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/**
 * The page's end reason when a socket message cannot carry it: leaving the
 * page (navigator.sendBeacon on pagehide / unload, public/voice-live.js). The
 * body is {_csrf, call, why}. Ends that call if it is still open (the socket's
 * close may not have arrived yet) and logs the reason either way.
 */
app.post("/joya-ai/api/live/end", ...joyaAiWrite, (req, res) => {
  const b = req.body || {};
  const why = typeof b.why === "string" && /^(?:unload|navigate|button|error:[^\u0000-\u001f]{0,80})$/.test(b.why) ? b.why : "unspecified";
  const id = typeof b.call === "string" && /^lv[a-z0-9]{1,40}$/.test(b.call) ? b.call : null;
  const call = voiceLive.callFor(req.me.username);
  const rep = voiceLive.pageReport(b.diag);
  if (rep) console.log(`live: call ${id || "?"} page report (beacon): ${rep}`);
  if (call && id && call.id === id) call.close("hung-up", undefined, why);
  else console.log(`live: call ${id || "?"} end reason from the page (beacon): ${why}${call ? "" : " (already ended)"}`);
  res.status(204).end();
});

app.post("/joya-ai/api/send", ...joyaAiWrite, async (req, res) => {
  try {
    const b0 = req.body || {};
    // Attached files (lib/uploads.js): ids the page got from /joya-ai/api/uploads, the sender's own. Their
    // lines are added here, never by the page; a voice turn carries none.
    if (b0.attachments !== undefined && b0.vt !== undefined) return res.status(400).json({ error: "A voice turn can't carry files.", code: "invalid" });
    const files = uploads.forSend(b0.attachments, req.me.username);
    const typed = typeof b0.text === "string" ? b0.text.trim() : "";
    const params = joyaai.cleanSend(files.length && !typed ? { ...b0, text: "(files attached)" } : b0);
    if (files.length) {
      params.text = (typed ? params.text + "\n\n" : "") + require("./lib/uploads").trailer(files);
      if (params.text.length > 20000) throw Object.assign(new Error("The message and its file list are too long. Shorten the message."), { code: "invalid" });
    }
    // A voice turn (the page sends its voice-turn id): JOYA AI gets exactly
    // what this server heard for it, once -- never a prompt echo, never words
    // that no transcript here produced. Typed turns are the administrator's
    // own keystrokes and pass as before.
    const refusal = voiceIntake.sendRefusal({ grounds: voiceGrounds, actor: req.me.username, body: req.body || {}, text: params.text });
    if (refusal) {
      voiceLog("send", "refused", { rule: refusal.rule, source: refusal.source ? JSON.stringify(refusal.source) : undefined });
      return res.status(422).json({ error: "That voice turn was not sent: it does not match what was heard.", code: "ungrounded" });
    }
    // A pending Tier-2 confirm: this "yes" / "no" answers it and goes no further.
    const conf = files.length ? null : uiConfirmHeard({ username: req.me.username, ip: req.ip }, params.text, "typed or direct voice");
    if (conf && (conf.confirmed || conf.cancelled)) return res.json({ confirm: { id: (conf.confirmed || conf.cancelled).id, ok: !!conf.confirmed } });
    db.logLogin(req.ip, req.me.username, "joya-ai", `turn${params.target ? " for " + params.target : ""}${files.length ? ` with ${files.length} file${files.length === 1 ? "" : "s"}` : ""}`);
    // A one-time ui token for this send, from this tab (lib/ui-relay.js).
    const ut = uiRelay.joya({ actor: req.me.username, tab: (req.body || {}).tab, via: "page" });
    if (ut) params.ut = ut;
    const sent = await joyaai.call("send", params, req.me.username);
    if (ut && sent && sent.turn) uiRelay.bind(ut, sent.turn.id); // this token, that turn only
    res.json(sent);
  } catch (e) {
    joyaAiFail(res, e);
  }
});

app.post("/joya-ai/api/interrupt", ...joyaAiWrite, async (req, res) => {
  try {
    res.json(await joyaai.call("interrupt", {}, req.me.username));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/*
 * Approve once and Always allow this need Windows Hello (or the code), bound
 * to this approval and -- for Always allow -- to the exact rule; Deny never
 * does. Covers every card that comes through here: JOYA AI's own, a hired or
 * machine session's (origin session:<slug>) and a retire consent.
 */
const approvalStepUp = stepup.requireStepUp({
  bind: (req) => {
    if (req.params.decision !== "approve") return null;
    const id = joyaai.cleanApprovalId(req.params.id);
    const always = joyaai.cleanAlwaysRule(req.body);
    return `approval:${id}:approve` + (always ? ":always:" + stepBindHash(always.rule_tool, always.rule_pattern) : "");
  },
  what: (req) => `${req.body && req.body.rule ? "Always allow" : "Approve"} request #${req.params.id}`,
  hold: (req) => holdApproval(req, joyaai.cleanApprovalId(req.params.id)),
  audit: stepAudit,
});
app.post("/joya-ai/api/approvals/:id/:decision", ...joyaAiWrite, approvalStepUp, async (req, res) => {
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "deny") return res.status(404).json({ error: "No such action." });
  try {
    const params = { approval_id: joyaai.cleanApprovalId(req.params.id) };
    const note = joyaai.cleanNote(req.body && req.body.note);
    if (note) params.note = note;
    const always = decision === "approve" ? joyaai.cleanAlwaysRule(req.body) : null;
    if (always) Object.assign(params, always);
    const out = decision === "approve" ? await callStepped(req, decision, params) : await joyaai.call(decision, params, req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ai", `${decision === "approve" ? "approved" : "denied"} request ${params.approval_id}${always ? " and saved an always-allow rule" : ""}${steppedWith(req)}`);
    res.json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
});

app.post("/joya-ai/api/rc", ...joyaAiWrite, async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false." });
  try {
    db.logLogin(req.ip, req.me.username, "joya-ai", `remote control ${enabled ? "on" : "off"}`);
    res.json(await joyaai.call("rc", { enabled }, req.me.username, { timeout: 60000 }));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/**
 * Read-aloud for the Command Center ("Read replies aloud" and a reply's Read
 * aloud), through OpenAI and only through this server: a reply is read a
 * sentence at a time, its audio streamed back. The browser never talks to
 * OpenAI. Nothing is saved. Refused (409 voice-off) while voice is off, and
 * only for those who may use the voice (voice.use).
 *
 * The Command Center's push to talk (/joya-ai/api/transcribe) and the voice
 * front desk (/joya-ai/api/desk/turn, /desk/summary) were removed on
 * 2026-09-30: voice is live conversation only, and the live call hears on the
 * server (lib/voice-live.js).
 */
app.post("/joya-ai/api/speak", ...joyaAiWrite, requireApiPerm("voice.use"), voiceSpeakRoute);

/**
 * The voice's usage figures for the Command Center: today's and this month's
 * spend (Cairo), split by kind of turn and transcription, and the last turn.
 */
app.get("/joya-ai/api/voice/usage", ...joyaAiGuard, (req, res) => {
  const u = voiceUsageSummary();
  if (u.error) return res.status(500).json({ error: "Voice usage is not available." });
  res.json(u);
});

app.post("/joya-ai/api/restart", ...joyaAiWrite, async (req, res) => {
  try {
    db.logLogin(req.ip, req.me.username, "joya-ai", "restarted JOYA AI");
    res.json(await joyaai.call("restart", {}, req.me.username, { timeout: 90000 }));
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/* ------------------------------- JOYA AI: Command Center v3, phase 1 --- */
/*
 * Missions, decisions and watchers, standing orders, approval rules, cost, the
 * machine card and the read-only session mirror. Each route is a thin, checked
 * proxy to one supervisor op (joya-ai/lib/protocol.js re-validates all of it).
 * Writes carry CSRF, reach the supervisor with the panel user as actor (it
 * audits them) and leave a line in the panel's own log too.
 */

async function joyaAiOp(req, res, op, params, { log: what, timeout } = {}) {
  try {
    const out = await joyaai.call(op, params || {}, req.me.username, timeout ? { timeout } : undefined);
    if (what) db.logLogin(req.ip, req.me.username, "joya-ai", String(what).slice(0, 200));
    res.json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
}
/** Run a cleaner; answer 400 on a bad request. Returns undefined when it already answered. */
function joyaAiClean(res, fn) {
  try {
    return fn();
  } catch (e) {
    joyaAiFail(res, e);
    return undefined;
  }
}

app.get("/joya-ai/api/machine", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "machine"));

// approvals: the narrow "Always allow this" rule to show before saving it
app.get("/joya-ai/api/approvals/:id/rule-suggestion", ...joyaAiGuard, (req, res) => {
  const id = joyaAiClean(res, () => joyaai.cleanApprovalId(req.params.id));
  if (id !== undefined) joyaAiOp(req, res, "rule-suggest", { approval_id: id });
});

// missions
app.get("/joya-ai/api/missions", ...joyaAiGuard, (req, res) => {
  const status = req.query && req.query.status === "active" ? "active" : "all";
  joyaAiOp(req, res, "missions", { status });
});
app.get("/joya-ai/api/missions/:id", ...joyaAiGuard, (req, res) => {
  const id = joyaAiClean(res, () => joyaai.missionIdOf(req.params.id));
  if (id !== undefined) joyaAiOp(req, res, "mission", { mission_id: id });
});
app.post("/joya-ai/api/missions/request", ...joyaAiWrite, (req, res) => {
  const goal = joyaAiClean(res, () => joyaai.str(req.body && req.body.goal, "The goal", { max: 4000 }));
  if (goal !== undefined) joyaAiOp(req, res, "mission-request", { goal }, { log: "asked for a mission" });
});

// decisions
app.get("/joya-ai/api/decisions", ...joyaAiGuard, (req, res) => {
  joyaAiOp(req, res, "decisions", { status: req.query && req.query.status === "all" ? "all" : "open" });
});
// Apply fix / Retire (approve) and Resume for today need Windows Hello; Dismiss and Ask more do not.
const decisionStepUp = stepup.requireStepUp({
  bind: (req) => (["approve", "resume"].includes(req.params.action) ? `decision:${joyaai.idOf(req.params.id, "decision")}:${req.params.action}` : null),
  what: (req) => (req.params.action === "resume" ? "Resume past the daily cap" : "Approve decision #" + req.params.id),
  audit: stepAudit,
});
app.post("/joya-ai/api/decisions/:id/:action", ...joyaAiWrite, decisionStepUp, async (req, res) => {
  const action = req.params.action;
  if (!["approve", "dismiss", "ask", "resume"].includes(action)) return res.status(404).json({ error: "No such action." });
  // Resume is a daily-token-cap card's (Settings > Usage & budget): the supervisor's budget-resume.
  if (action === "resume" || action === "approve") {
    const p = joyaAiClean(res, () => {
      const o = { decision_id: joyaai.idOf(req.params.id, "decision") };
      const note = action === "approve" ? joyaai.cleanNote(req.body && req.body.note) : undefined;
      if (note) o.note = note;
      return o;
    });
    if (p === undefined) return;
    try {
      const out = await callStepped(req, action === "resume" ? "budget-resume" : "decision-approve", p);
      db.logLogin(req.ip, req.me.username, "joya-ai", `${action === "resume" ? `resumed past the daily cap (decision ${p.decision_id})` : `approve decision ${p.decision_id}`}${steppedWith(req)}`);
      res.json(out);
    } catch (e) {
      joyaAiFail(res, e);
    }
    return;
  }
  const params = joyaAiClean(res, () => {
    const p = { decision_id: joyaai.idOf(req.params.id, "decision") };
    if (action === "ask") p.text = joyaai.str(req.body && req.body.text, "Your question", { max: 4000 });
    else {
      const note = joyaai.cleanNote(req.body && req.body.note);
      if (note) p.note = note;
    }
    return p;
  });
  if (params) joyaAiOp(req, res, "decision-" + action, params, { log: `${action} decision ${params.decision_id}` });
});

// watchers
app.get("/joya-ai/api/watchers", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "watchers"));
app.post("/joya-ai/api/watchers/:key", ...joyaAiWrite, (req, res) => {
  const params = joyaAiClean(res, () => {
    const key = joyaai.oneOf(req.params.key, "Watcher", joyaai.WATCHERS);
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== "boolean") throw new joyaai.JoyaAiError("enabled must be true or false.", "invalid");
    return { key, enabled };
  });
  if (params) joyaAiOp(req, res, "watcher-set", params, { log: `watcher ${params.key} ${params.enabled ? "on" : "off"}` });
});

// standing orders
app.get("/joya-ai/api/orders", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "orders"));
app.get("/joya-ai/api/orders/:id/runs", ...joyaAiGuard, (req, res) => {
  const id = joyaAiClean(res, () => joyaai.idOf(req.params.id, "standing order"));
  if (id !== undefined) joyaAiOp(req, res, "order-runs", { order_id: id });
});
app.post("/joya-ai/api/orders", ...joyaAiWrite, (req, res) => {
  const p = joyaAiClean(res, () => joyaai.cleanOrder(req.body, false));
  if (p) joyaAiOp(req, res, "order-create", p, { log: "created a standing order" });
});
app.post("/joya-ai/api/orders/:id", ...joyaAiWrite, (req, res) => {
  const p = joyaAiClean(res, () => ({ order_id: joyaai.idOf(req.params.id, "standing order"), ...joyaai.cleanOrder(req.body, true) }));
  if (p) joyaAiOp(req, res, "order-update", p, { log: `updated standing order ${p.order_id}` });
});
app.post("/joya-ai/api/orders/:id/:action", ...joyaAiWrite, (req, res) => {
  const action = req.params.action;
  if (!["delete", "run", "pause"].includes(action)) return res.status(404).json({ error: "No such action." });
  const p = joyaAiClean(res, () => {
    const o = { order_id: joyaai.idOf(req.params.id, "standing order") };
    if (action === "pause") {
      if (typeof (req.body && req.body.paused) !== "boolean") throw new joyaai.JoyaAiError("paused must be true or false.", "invalid");
      o.paused = req.body.paused;
    }
    return o;
  });
  if (p) joyaAiOp(req, res, "order-" + action, p, { log: `${action} standing order ${p.order_id}` });
});

// approval rules
app.get("/joya-ai/api/rules", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "rules"));
app.post("/joya-ai/api/rules/test", ...joyaAiWrite, (req, res) => {
  const p = joyaAiClean(res, () =>
    strip2({ command: joyaai.str(req.body && req.body.command, "The command", { max: 8000 }), tool: joyaai.oneOf(req.body && req.body.tool, "Tool", ["Bash", "SendMessage"], true) })
  );
  if (p) joyaAiOp(req, res, "rule-test", p);
});
/*
 * Rules that can let something run need Windows Hello: a new allow rule, and
 * any change to or removal of a rule (a changed pattern or effect, or a deny /
 * ask rule gone, can loosen the gate). A new deny or ask rule only tightens it
 * and goes through as before.
 */
async function joyaAiOpStepped(req, res, op, params, what) {
  try {
    const out = await callStepped(req, op, params);
    db.logLogin(req.ip, req.me.username, "joya-ai", String(what + steppedWith(req)).slice(0, 200));
    res.json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
}
const ruleStepUp = (kind) =>
  stepup.requireStepUp({
    bind: (req) => {
      if (kind === "create") {
        const r = joyaai.cleanRule(req.body, false);
        return r.effect === "allow" ? "rule:create:" + stepBindHash(r.effect, r.tool, r.pattern) : null;
      }
      const id = joyaai.idOf(req.params.id, "rule");
      if (kind === "delete") return `rule:${id}:delete`;
      const r = joyaai.cleanRule(req.body, true);
      return `rule:${id}:update:` + stepBindHash(r.effect || null, r.tool || null, r.pattern === undefined ? null : r.pattern);
    },
    what: (req) => (kind === "create" ? "Save an allow rule" : kind === "delete" ? `Delete rule #${req.params.id}` : `Change rule #${req.params.id}`),
    audit: stepAudit,
  });
app.post("/joya-ai/api/rules", ...joyaAiWrite, ruleStepUp("create"), (req, res) => {
  const p = joyaAiClean(res, () => joyaai.cleanRule(req.body, false));
  if (!p) return;
  if (req.stepUp) return joyaAiOpStepped(req, res, "rule-create", p, `added a ${p.effect} rule`);
  joyaAiOp(req, res, "rule-create", p, { log: `added a ${p.effect} rule` });
});
app.post("/joya-ai/api/rules/:id", ...joyaAiWrite, ruleStepUp("update"), (req, res) => {
  const p = joyaAiClean(res, () => ({ rule_id: joyaai.idOf(req.params.id, "rule"), ...joyaai.cleanRule(req.body, true) }));
  if (p) joyaAiOpStepped(req, res, "rule-update", p, `changed rule ${p.rule_id}`);
});
app.post("/joya-ai/api/rules/:id/delete", ...joyaAiWrite, ruleStepUp("delete"), (req, res) => {
  const id = joyaAiClean(res, () => joyaai.idOf(req.params.id, "rule"));
  if (id !== undefined) joyaAiOpStepped(req, res, "rule-delete", { rule_id: id }, `deleted rule ${id}`);
});
function strip2(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// usage: Claude plan limits as Claude Code's /usage shows them (the supervisor
// asks the CLI; no credential passes through here) and the token counts.
app.get("/joya-ai/api/usage", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "usage", req.query.plan_only === "1" ? { plan_only: true } : {}, { timeout: 35000 }));

// token caps, read only (the desktop app's "Today" glance card: today's tokens against the tightest daily
// cap; the caps are set in Settings > Usage)
app.get("/joya-ai/api/caps", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "token-caps"));

// cost
app.get("/joya-ai/api/cost", ...joyaAiGuard, (req, res) => joyaAiOp(req, res, "cost"));
app.post("/joya-ai/api/cost/budget", ...joyaAiWrite, (req, res) => {
  const p = joyaAiClean(res, () => joyaai.cleanBudget(req.body));
  if (p) joyaAiOp(req, res, "cost-budget", p, { log: "set the daily budget" });
});

// the read-only session deep view
app.get("/joya-ai/api/sessions/:sid/mirror", ...joyaAiGuard, (req, res) => {
  if (!joyaai.SESSION_ID_RE.test(String(req.params.sid || ""))) return res.status(404).json({ error: "No such session." });
  joyaAiOp(req, res, "session-mirror", { session_id: req.params.sid });
});

// The session story and the day timeline (public/cc-story.js): read-only, cached a few seconds (lib/story-api.js).
const storyApi = require("./lib/story-api");
const storyCache = storyApi.createCache();
app.get("/joya-ai/api/sessions/:sid/story", ...joyaAiGuard, async (req, res) => {
  let sid;
  try {
    sid = storyApi.cleanSession(req.params.sid);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
  try {
    const out = await storyCache.get("session", sid, () => joyaai.call("session-story", { session_id: sid }, req.me.username, { timeout: 30000 }));
    res.set("Cache-Control", "private, no-store").json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
});
app.get("/joya-ai/api/story/day", ...joyaAiGuard, async (req, res) => {
  const day = joyaAiClean(res, () => storyApi.cleanDay(req.query && req.query.day));
  if (day === undefined) return;
  try {
    const out = await storyCache.get("day", day || "today", () => joyaai.call("story-day", day ? { day } : {}, req.me.username, { timeout: 30000 }));
    res.set("Cache-Control", "private, no-store").json(out);
  } catch (e) {
    joyaAiFail(res, e);
  }
});

/* ------------------------------------------------------- channel members --- */

app.post("/channels/:slug/members/add", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const pattern = channel.type === "telegram" ? TELEGRAM_ID_RE : PHONE_RE;
  if (!pattern.test(id))
    return back(
      "err=" +
        encodeURIComponent(
          channel.type === "telegram"
            ? "A Telegram user ID is 4-15 digits. Message @userinfobot to find yours."
            : "Use a phone number in E.164 form, like +201234567890."
        )
    );

  const members = memberList(channel);
  if (members.includes(id)) return back("err=" + encodeURIComponent("Already on the list."));

  members.push(id);
  try {
    await saveMembers(channel, members);
    back(
      "msg=" +
        encodeURIComponent(
          members.length === 1
            ? id + " added, and is the administrator of this channel."
            : id + " added."
        )
    );
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

app.post("/channels/:slug/members/promote", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const members = memberList(channel);
  if (!members.includes(id)) return back("err=" + encodeURIComponent("Not on the list."));

  // Promotion is a reorder, not an extra flag: the administrator is defined as
  // position zero, so there is only ever one and it cannot drift out of sync
  // with the list it is meant to describe.
  const reordered = [id, ...members.filter((m) => m !== id)];
  try {
    await saveMembers(channel, reordered);
    db.logLogin(req.ip, req.me.username, "admin", "made " + id + " administrator of " + channel.slug);
    back("msg=" + encodeURIComponent(id + " is now the administrator of this channel."));
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

app.post("/channels/:slug/members/remove", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const members = memberList(channel).filter((m) => m !== id);
  try {
    await saveMembers(channel, members);
    back(
      "msg=" +
        encodeURIComponent(
          members.length
            ? id + " removed. " + members[0] + " is the administrator."
            : id + " removed. Nobody can use this channel now."
        )
    );
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

/* ---------------------------------------------------------------- users --- */

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const ROLE_NAME_RE = /^[a-z0-9_-]{2,32}$/;

// Deliberately loose. Anything stricter starts rejecting real addresses, and
// this field is a label on an authenticator entry and a way to reach the
// person -- not a credential, so nothing is decided by its exact shape. No
// domain is pinned: any address will do, and deciding which ones count is a
// policy that belongs to whoever runs the panel rather than to this line.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Scope inputs arrive as a mode radio plus a checkbox list. */
function readScope(body, name) {
  if (field(body, name + "_mode") !== "list") return "*";
  const raw = body[name];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((s) => String(s).trim())
    .filter((s) => SLUG_RE.test(s));
  return [...new Set(list)].join(",");
}

/** Only slugs and display names reach the role editor's scope pickers. */
async function scopeOptions() {
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
  });
  return {
    agents: (data.agents || []).map((a) => ({ slug: a.slug, name: a.name })),
    channels: (data.channels || []).map((c) => ({ slug: c.slug, name: c.name })),
  };
}

app.get("/users", requireAuth, requirePerm("users.view"), (req, res) => {
  res.send(
    accessViews.users({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      users: db.listUsers(),
      roles: db.listRoles(),
      missingEmail: db.usersMissingEmail(),
      flash: req.query.msg || null,
      err: req.query.err || null,
      meId: req.me.id,
      canManage: req.perm.can("users.manage"),
      sessionsOf: (id) => { try { return deviceSessions.sessionsFor(id).count; } catch (_) { return null; } },
    })
  );
});

app.get("/users/new", requireAuth, requirePerm("users.manage"), (req, res) => {
  res.send(
    accessViews.userNew({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      roles: db.listRoles(),
    })
  );
});

app.post("/users/new", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const username = field(req.body, "username");
  const displayName = field(req.body, "display_name");
  const email = field(req.body, "email");
  const password = String(req.body.password || "");
  const roleId = Number(field(req.body, "role_id"));

  const errors = [];
  if (!USERNAME_RE.test(username))
    errors.push("Username must be 3-32 characters (letters, digits, . _ -).");
  if (db.getUserByName(username)) errors.push("That username is already taken.");
  if (!EMAIL_RE.test(email)) errors.push("Enter their email address.");
  else if (db.getUserByEmail(email)) errors.push("Another account already uses that email.");
  if (password.length < 12) errors.push("Password must be at least 12 characters.");
  if (!db.getRole(roleId)) errors.push("Pick a role.");
  if (errors.length)
    return res.status(400).send(
      accessViews.userNew({
        csrf: res.locals.csrf,
        user: ctx(req, "os"),
        roles: db.listRoles(),
        form: { username, display_name: displayName, email, role_id: roleId },
        errors,
      })
    );

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const secret = authenticator.generateSecret();
  const info = db.createUser({
    username,
    displayName,
    email,
    passwordHash: hash,
    totpSecret: secret,
    roleId,
    createdBy: req.me.username,
  });
  if (PASSWORD_ONLY) db.confirmUserTotp(info.lastInsertRowid); // nothing to enrol (lib/signin.js)
  const target = db.getUser(info.lastInsertRowid);
  const qr = PASSWORD_ONLY ? null : await enrolQr(target, secret);
  // Rendered directly rather than redirected to: the password and the secret
  // exist only in this response, and a redirect would have to carry them in a
  // URL, which is the one place they must never be.
  res.send(
    accessViews.userEnrol({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      target,
      qr,
      secret: PASSWORD_ONLY ? null : secret,
      password,
      passwordOnly: PASSWORD_ONLY,
    })
  );
});

/** Load the target user and work out what may be done to them. */
function userContext(req) {
  const target = db.getUser(Number(req.params.id));
  if (!target) return null;
  const isSelf = req.me.id === target.id;
  const isAdmin = target.role && target.role.permissions.includes("*");
  return { target, isSelf, lastAdmin: isAdmin && db.countActiveAdmins() <= 1 };
}

app.get("/users/:id", requireAuth, requirePerm("users.view"), (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  res.send(
    accessViews.userDetail({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      ...c,
      passkeyCount: passkeys.countFor(c.target.id),
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/users/:id", requireAuth, requirePerm("users.manage"), requireCsrf, (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  // Users > Manage (the dialog on /users) comes back to the list; the full page to itself.
  const back = field(req.body, "back") === "/users" ? "/users" : "/users/" + c.target.id;

  const roleId = c.lastAdmin ? c.target.role_id : Number(field(req.body, "role_id"));
  const disabled = !c.lastAdmin && !c.isSelf && field(req.body, "disabled") === "1";
  const email = field(req.body, "email");
  if (!db.getRole(roleId))
    return res.redirect(back + "?err=" + encodeURIComponent("Unknown role."));
  if (!EMAIL_RE.test(email))
    return res.redirect(back + "?err=" + encodeURIComponent("Enter their email address."));
  const clash = db.getUserByEmail(email);
  if (clash && clash.id !== c.target.id)
    return res.redirect(
      back + "?err=" + encodeURIComponent("Another account already uses that email.")
    );

  // Changing the address changes the label an already-enrolled phone shows, but
  // not the secret -- so nothing re-enrols and nobody is locked out. The entry
  // on their phone keeps the old label until they next enrol.
  const relabelled = email.toLowerCase() !== String(c.target.email || "").toLowerCase();

  db.updateUser(c.target.id, {
    displayName: field(req.body, "display_name") || c.target.username,
    email,
    roleId,
    disabled,
  });
  res.redirect(
    back +
      "?msg=" +
      encodeURIComponent(
        relabelled && c.target.totp_confirmed
          ? "Saved. Their authenticator keeps working — the new address only shows on a fresh enrolment."
          : "Saved."
      )
  );
});

app.post("/users/:id/password", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const back = "/users/" + c.target.id;
  const password = String(req.body.password || "");
  if (password.length < 12)
    return res.redirect(back + "?err=" + encodeURIComponent("Password must be at least 12 characters."));
  db.setUserPassword(c.target.id, await argon2.hash(password, { type: argon2.argon2id }));
  db.logLogin(req.ip, req.me.username, "admin", "reset password for " + c.target.username);
  res.redirect(back + "?msg=" + encodeURIComponent("Password reset. Give them the new one directly."));
});

app.post("/users/:id/totp", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const secret = authenticator.generateSecret();
  db.setUserTotp(c.target.id, secret, false);
  // A reset is for a lost or compromised device, and a passkey is a device:
  // every one of theirs goes with the old authenticator.
  const cleared = passkeys.clearFor(c.target.id);
  db.logLogin(
    req.ip,
    req.me.username,
    "admin",
    "reset 2FA for " + c.target.username + (cleared ? ` and removed ${cleared} passkey${cleared === 1 ? "" : "s"}` : "")
  );
  const qr = await enrolQr(c.target, secret);
  res.send(
    accessViews.userEnrol({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      target: c.target,
      qr,
      secret,
      password: "(unchanged — reset it separately if they also lost that)",
      reset: { passkeys: cleared },
    })
  );
});

app.post("/users/:id/delete", requireAuth, requirePerm("users.manage"), requireCsrf, (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  if (c.isSelf || c.lastAdmin)
    return res.redirect(
      "/users/" + c.target.id + "?err=" + encodeURIComponent("That account cannot be deleted.")
    );
  db.deleteUser(c.target.id);
  db.logLogin(req.ip, req.me.username, "admin", "deleted user " + c.target.username);
  res.redirect("/users?msg=" + encodeURIComponent(c.target.username + " removed."));
});

/**
 * Sign every browser of another user out (Users ▸ Manage). Their live voice
 * calls end with the sessions. Your own go through Devices, which keeps the
 * one you are using -- so your own id is refused here. `back=detail` returns
 * to the full-page /users/:id; anything else to /users.
 */
app.post("/users/:id/signout-all", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const back = field(req.body, "back") === "detail" ? "/users/" + c.target.id : "/users";
  if (c.isSelf)
    return res.redirect(back + "?err=" + encodeURIComponent("Use Devices to sign out your own browsers; it keeps the one you are using."));
  const sids = deviceSessions.sidsFor(c.target.id, null);
  const n = await deviceSessions.destroyMany(sids);
  endCallsFor(sids, "signed out by an administrator");
  deviceSessions.forget(c.target.id);
  db.logLogin(req.ip, req.me.username, "admin", `signed out ${n} browser${n === 1 ? "" : "s"} of ${c.target.username}`);
  res.redirect(back + "?msg=" + encodeURIComponent(n ? `Signed ${c.target.username} out of ${n} browser${n === 1 ? "" : "s"}.` : `${c.target.username} was not signed in anywhere.`));
});

/* ---------------------------------------------------------------- roles --- */

app.get("/roles", requireAuth, requirePerm("roles.view"), async (req, res) => {
  const canManage = req.perm.can("roles.manage");
  // The Manage dialogs carry the scope pickers, so they need the agent and channel lists.
  const opts = canManage ? await scopeOptions() : { agents: [], channels: [] };
  res.send(
    accessViews.roles({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
      canManage,
      ...opts,
    })
  );
});

app.get("/roles/new", requireAuth, requirePerm("roles.manage"), async (req, res) => {
  const opts = await scopeOptions();
  res.send(
    accessViews.roleEdit({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      role: { permissions: [], agent_scope: "*", channel_scope: "*" },
      isNew: true,
      readOnly: false,
      ...opts,
    })
  );
});

app.post("/roles/new", requireAuth, requirePerm("roles.manage"), requireCsrf, async (req, res) => {
  const name = field(req.body, "name").toLowerCase();
  const label = field(req.body, "label");
  const description = field(req.body, "description");
  const raw = req.body.permissions;
  const permissions = rbac.closure(Array.isArray(raw) ? raw : raw ? [raw] : []);

  const errors = [];
  if (!ROLE_NAME_RE.test(name)) errors.push("Name must be 2-32 lowercase letters, digits, - or _.");
  if (db.getRoleByName(name)) errors.push("A role with that name already exists.");
  if (!label) errors.push("Give the role a label.");
  if (errors.length) {
    const opts = await scopeOptions();
    return res.status(400).send(
      accessViews.roleEdit({
        csrf: res.locals.csrf,
        user: ctx(req, "os"),
        role: {
          name,
          label,
          description,
          permissions,
          agent_scope: readScope(req.body, "agent_scope"),
          channel_scope: readScope(req.body, "channel_scope"),
        },
        isNew: true,
        readOnly: false,
        errors,
        ...opts,
      })
    );
  }

  db.createRole({
    name,
    label,
    description,
    permissions,
    agentScope: readScope(req.body, "agent_scope"),
    channelScope: readScope(req.body, "channel_scope"),
  });
  res.redirect("/roles?msg=" + encodeURIComponent(label + " created."));
});

app.get("/roles/:id", requireAuth, requirePerm("roles.view"), async (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  const opts = await scopeOptions();
  res.send(
    accessViews.roleEdit({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      role: { ...role, user_count: db.roleUserCount(role.id) },
      isNew: false,
      // Viewing without roles.manage, and the built-in administrator for
      // anyone, are both read-only.
      readOnly: role.builtin || !req.perm.can("roles.manage"),
      flash: req.query.msg || null,
      ...opts,
    })
  );
});

app.post("/roles/:id", requireAuth, requirePerm("roles.manage"), requireCsrf, (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  if (role.builtin)
    return res.redirect("/roles/" + role.id + "?err=" + encodeURIComponent("Built-in roles cannot be edited."));

  const raw = req.body.permissions;
  db.updateRole(role.id, {
    label: field(req.body, "label") || role.label,
    description: field(req.body, "description"),
    permissions: rbac.closure(Array.isArray(raw) ? raw : raw ? [raw] : []),
    agentScope: readScope(req.body, "agent_scope"),
    channelScope: readScope(req.body, "channel_scope"),
  });
  db.logLogin(req.ip, req.me.username, "admin", "edited role " + role.name);
  // Roles > Manage (the dialog on /roles) comes back to the list.
  const back = field(req.body, "back") === "/roles" ? "/roles" : "/roles/" + role.id;
  res.redirect(back + "?msg=" + encodeURIComponent(role.label + " saved."));
});

app.post("/roles/:id/delete", requireAuth, requirePerm("roles.manage"), requireCsrf, (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  if (role.builtin || db.roleUserCount(role.id) > 0)
    return res.redirect(
      "/roles/" + role.id + "?err=" + encodeURIComponent("That role cannot be deleted right now.")
    );
  db.deleteRole(role.id);
  res.redirect("/roles?msg=" + encodeURIComponent(role.label + " deleted."));
});

/* -------------------------------------------------------------- account --- */

app.get("/account", requireAuth, (req, res) => {
  res.send(
    accessViews.account({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      flash: req.query.msg || null,
      err: req.query.err || null,
      // A pointer to Settings > Appearance, for those who can open the Command Center.
      appearance: req.perm.can("joyaai.use"),
      passkeys: accountPasskeys(req),
      passwordOnly: PASSWORD_ONLY,
    })
  );
});

/* --- passkeys (Windows Hello) on your own account ------------------------ */

/**
 * Adding a passkey adds a way past the second step, so it asks for the second
 * factor again: a current authenticator code, unless both factors were shown
 * within the last few minutes (a fresh sign-in, or a code given here).
 */
const PASSKEY_REAUTH_MS = Number(process.env.JOYA_PASSKEY_REAUTH_MS) > 0 ? Number(process.env.JOYA_PASSKEY_REAUTH_MS) : 5 * 60 * 1000;
const freshAuth = (req) => Date.now() - Number(req.session.authAt || 0) < PASSKEY_REAUTH_MS;

/** What the account page shows: this address, its passkeys and the rest. */
function accountPasskeys(req) {
  const rp = passkeys.rpFor(req);
  const all = passkeys.listFor(req.me.id);
  return {
    host: passkeys.hostOf(req),
    rpID: rp ? rp.rpID : null,
    primary: passkeys.primaryOrigin(),
    list: all,
    here: rp ? all.filter((p) => p.rp_id === rp.rpID).length : 0,
    fresh: freshAuth(req),
    suggestedName: ((l) => (l === "Unknown browser" ? "" : l))(deviceSessions.parseUA(req.get("user-agent")).label),
  };
}

app.post("/account/passkeys/options", requireAuth, passkeyLimiter, requireCsrf, async (req, res) => {
  const rp = passkeys.rpFor(req);
  if (!rp) return res.status(400).json({ error: "Passkeys cannot be added at this address. Open " + (passkeys.primaryOrigin() || "the panel's main address") + " and add it there." });
  if (!freshAuth(req)) {
    if (!totp.verifyAndConsume(req.me, req.body && req.body.code)) {
      logAuthFailure(req.ip, "bad code adding a passkey");
      db.logLogin(req.ip, req.me.username, "fail", "bad code adding a passkey");
      return res.status(403).json({ error: "That code was not accepted. Try the next one.", code: true });
    }
    req.session.authAt = Date.now();
  }
  req.session.passkeyReg = {};
  res.json({ options: await passkeys.registrationOptions(req.me, rp, req.session.passkeyReg) });
});

app.post("/account/passkeys", requireAuth, passkeyLimiter, requireCsrf, async (req, res) => {
  const rp = passkeys.rpFor(req);
  const slot = req.session.passkeyReg || {};
  delete req.session.passkeyReg;
  if (!rp) return res.status(400).json({ error: "Passkeys cannot be added at this address." });
  const name = passkeys.cleanName(req.body && req.body.name, deviceSessions.parseUA(req.get("user-agent")).label);
  const r = await passkeys.verifyRegistration(req.me, rp, slot, req.body && req.body.response, name);
  if (!r.ok) {
    db.logLogin(req.ip, req.me.username, "fail", "passkey not added: " + r.error);
    return res.status(400).json({ error: "The passkey was not added (" + r.error + ")." });
  }
  db.logLogin(req.ip, req.me.username, "account", `added passkey "${r.passkey.name}" for ${rp.rpID}`);
  res.json({ ok: true, msg: `Passkey "${r.passkey.name}" added. Next time, sign in with Windows Hello on this device.` });
});

app.post("/account/passkeys/:id/rename", requireAuth, requireCsrf, (req, res) => {
  const was = passkeys.listFor(req.me.id).find((p) => p.id === Number(req.params.id));
  const pk = passkeys.rename(req.me.id, req.params.id, req.body.name);
  if (!pk) return res.redirect("/account?err=" + encodeURIComponent("No such passkey.") + "#passkeys");
  db.logLogin(req.ip, req.me.username, "account", `renamed passkey "${was.name}" to "${pk.name}"`);
  res.redirect("/account?msg=" + encodeURIComponent(`Renamed to "${pk.name}".`) + "#passkeys");
});

app.post("/account/passkeys/:id/delete", requireAuth, requireCsrf, (req, res) => {
  const pk = passkeys.remove(req.me.id, req.params.id);
  if (!pk) return res.redirect("/account?err=" + encodeURIComponent("No such passkey.") + "#passkeys");
  db.logLogin(req.ip, req.me.username, "account", `removed passkey "${pk.name}" (${pk.rp_id})`);
  res.redirect(
    "/account?msg=" +
      encodeURIComponent(`Passkey "${pk.name}" removed. Remove it from Windows too (Settings ▸ Accounts ▸ Passkeys) so it stops being offered.`) +
      "#passkeys"
  );
});

/* Account > Appearance without JavaScript: a plain form post (see setJoyaCore). */
app.post("/account/appearance", requireAuth, requirePerm("joyaai.use"), requireCsrf, (req, res) => {
  const core = String((req.body && req.body.core) || "");
  const view = req.body && req.body.sessions_view !== undefined ? String(req.body.sessions_view) : null;
  // The no-JavaScript path of Settings > Appearance: back there with a note.
  const back = "/joya-ai/settings/appearance";
  if (!joyaLogic.isCore(core)) return res.redirect(back + "?err=" + encodeURIComponent("Choose core D (Mesh) or E (Bot).") + "#a-core");
  if (view !== null && !joyaLogic.isSessView(view)) return res.redirect(back + "?err=" + encodeURIComponent("Choose Spheres or Classic orbit.") + "#a-sessions");
  // Core E's head and colour preset, when the form carries them (custom colours are set with JavaScript).
  const head = req.body && req.body.bot_head !== undefined ? String(req.body.bot_head) : null;
  const preset = req.body && req.body.bot_preset !== undefined ? String(req.body.bot_preset) : null;
  if (head !== null && !joyaLogic.isBotHead(head)) return res.redirect(back + "?err=" + encodeURIComponent("Choose one of the bot heads.") + "#a-bot");
  const face = req.body && req.body.bot_face !== undefined ? String(req.body.bot_face) : null;
  if (face !== null && !joyaLogic.isBotFace(face)) return res.redirect(back + "?err=" + encodeURIComponent("Choose one of the bot faces.") + "#a-bot");
  let colors = null;
  if (preset !== null && preset !== "custom") {
    const c = joyaLogic.checkBotColors({ preset });
    if (!c.ok) return res.redirect(back + "?err=" + encodeURIComponent(c.error) + "#a-bot");
    colors = c.value;
  }
  setJoyaCore(req, core);
  if (view !== null) setSessionsView(req, view);
  if (head !== null) setBotHead(req, head);
  if (face !== null) setBotFace(req, face);
  if (colors) setBotColors(req, colors);
  res.redirect(back + "?msg=" + encodeURIComponent(`JOYA AI core: ${core} · ${joyaLogic.CORES[core]}${view ? ` · Sessions view: ${joyaLogic.SESS_VIEWS[view]}` : ""}.`) + "#a-core");
});

app.post("/account/password", requireAuth, requireCsrf, async (req, res) => {
  const current = String(req.body.current || "");
  const password = String(req.body.password || "");
  const fail = (m) => res.redirect("/account?err=" + encodeURIComponent(m));

  if (password.length < 12) return fail("New password must be at least 12 characters.");
  if (password !== String(req.body.password2 || "")) return fail("New passwords do not match.");

  let ok = false;
  try {
    ok = await argon2.verify(req.me.password_hash, current);
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    logAuthFailure(req.ip, "password change with wrong current password");
    return fail("Current password is not correct.");
  }

  db.setUserPassword(req.me.id, await argon2.hash(password, { type: argon2.argon2id }));
  res.redirect("/account?msg=" + encodeURIComponent("Password changed."));
});

/**
 * Confirm the authenticator you have just scanned, without signing out.
 *
 * A reset leaves the account "enrolment pending" until a code arrives, and the
 * only thing that used to deliver one was a fresh sign-in. Somebody who resets
 * their own factor, scans the new code and stays in an existing session is then
 * looking at a page that says they are not enrolled while their phone is
 * producing perfectly good codes. This closes that: one code, from the app they
 * just set up, and the account is confirmed.
 */
app.post("/account/authenticator/verify", requireAuth, requireCsrf, (req, res) => {
  if (req.me.totp_confirmed) return res.redirect("/account");
  if (!totp.verifyAndConsume(req.me, req.body.code)) {
    logAuthFailure(req.ip, "bad code confirming enrolment");
    return res.redirect(
      "/account?err=" +
        encodeURIComponent("That code was not accepted. Check the phone's clock and try the next one.")
    );
  }
  db.confirmUserTotp(req.me.id);
  db.logLogin(req.ip, req.me.username, "account", "confirmed authenticator enrolment");
  res.redirect("/account?msg=" + encodeURIComponent("Authenticator confirmed."));
});

/* --- moving your own authenticator to another app ----------------------- */

/**
 * How long a half-finished move stays open.
 *
 * Long enough to install an app and scan, short enough that a pending secret
 * does not sit in the session store for the rest of the day.
 */
const REENROL_MS = 15 * 60 * 1000;

/**
 * Move your second factor to a different app or phone, with no gap in cover.
 *
 * The alternative is an administrator reset, which needs a second
 * administrator on hand and leaves the account unable to sign in between the
 * reset and the new enrolment. Here the new secret lives in the session until a
 * code generated from it proves it actually arrived on the phone; only then
 * does it replace the old one. Abandon this halfway and nothing has changed.
 */
app.get("/account/authenticator", requireAuth, (req, res) => {
  res.send(
    accessViews.reenrolStart({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      err: req.query.err || null,
    })
  );
});

app.post("/account/authenticator", requireAuth, requireCsrf, async (req, res) => {
  const fail = (m) => res.redirect("/account/authenticator?err=" + encodeURIComponent(m));

  let ok = false;
  try {
    ok = await argon2.verify(req.me.password_hash, String(req.body.password || ""));
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    logAuthFailure(req.ip, "authenticator move with wrong password");
    return fail("Password is not correct.");
  }
  // A current code as well as the password: without it, a session left open on
  // an unlocked machine is enough to move the second factor to another phone,
  // which is the one thing the second factor exists to prevent.
  if (!totp.verifyAndConsume(req.me, req.body.code)) {
    logAuthFailure(req.ip, "authenticator move with bad code");
    return fail("That code was not accepted. Try the next one.");
  }

  const secret = authenticator.generateSecret();
  req.session.pendingTotp = { secret, at: Date.now() };
  res.send(
    accessViews.reenrolScan({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      qr: await enrolQr(req.me, secret),
      secret,
      err: null,
    })
  );
});

app.post("/account/authenticator/confirm", requireAuth, requireCsrf, async (req, res) => {
  const pending = req.session.pendingTotp;
  if (!pending || Date.now() - pending.at > REENROL_MS) {
    delete req.session.pendingTotp;
    return res.redirect(
      "/account/authenticator?err=" + encodeURIComponent("That took too long. Start again.")
    );
  }

  const code = String(req.body.code || "").replace(/\s/g, "");
  // Checked against the pending secret, not the account's, so this cannot be
  // satisfied by the app being replaced.
  if (!authenticator.check(code, pending.secret)) {
    return res.status(400).send(
      accessViews.reenrolScan({
        csrf: res.locals.csrf,
        user: ctx(req),
        me: req.me,
        qr: await enrolQr(req.me, pending.secret),
        secret: pending.secret,
        err: "That code was not accepted. Check the phone's clock and try the next one.",
      })
    );
  }

  db.setUserTotp(req.me.id, pending.secret, true);
  delete req.session.pendingTotp;
  db.logLogin(req.ip, req.me.username, "account", "moved authenticator to a new app");
  res.redirect(
    "/account?msg=" +
      encodeURIComponent("Authenticator moved. Codes from the old app no longer work.")
  );
});

/* ---------------------------------------------------------- claude code --- */

/*
 * Claude Code's memory, sessions and live processes. Administrator-only by
 * default (the claude.* permissions are in no stock role): transcripts carry
 * client data and this panel faces the internet.
 *
 * Every privileged step is a cc-* helper subcommand. The helper validates its
 * arguments again and writes the audit line; the checks here exist so an
 * obviously malformed request never reaches sudo at all.
 */

const CC_HOMES = new Set(["root", "console", "agents", "winarchive"]);
const CC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CC_SLUG = /^[A-Za-z0-9_.-]{1,255}$/;
const CC_MEMFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
const CC_AGENT = /^[A-Za-z0-9_-]{1,64}$/;

const ccActor = (req) => req.me.username;
const qint = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const withMsg = (path, key, text) =>
  path + (path.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(text);

/** 404 for a session address that could not possibly be valid. */
function ccSessionParams(req, res, next) {
  if (CC_HOMES.has(req.params.home) && CC_UUID.test(req.params.uuid)) return next();
  return res.status(404).send(views.error("Not found", "No such session."));
}

/* ------------------------------------------------------ memory graphs --- */

/**
 * The memory graphs' data, as JSON for the page's canvas (public/memgraph.js).
 *
 * Read-only: every one of these reads through the privileged helper, which
 * redacts, and is redacted again here. The permissions are the ones the pages
 * already use -- claude.memory.read for Claude Code's memory, and for an
 * agent's vault agents.memory.read plus the agent inside the actor's scope, so
 * an agent's memory is visible to exactly those who could open its Memory tab.
 * JSON refusals, not pages: a poll that loses its session should see a status
 * code rather than a sign-in form.
 */
function apiPerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.status(401).json({ error: "Sign in first." });
    if (!req.perm.can(perm)) return res.status(403).json({ error: "Your role does not include this." });
    next();
  };
}
const CURSOR_RE = /^\d{1,15}$/;

app.get("/api/claude/memory/graph", apiPerm("claude.memory.read"), async (req, res) => {
  const params = {};
  for (const [q, key] of [["after_f", "after_f"], ["after_c", "after_c"]]) {
    const v = String(req.query[q] || "");
    if (v && !CURSOR_RE.test(v)) return res.status(400).json({ error: "bad cursor" });
    if (v) params[key] = Number(v);
  }
  try {
    const raw = await priv.ccMemoryGraph(params);
    res.json(priv.redactDeep(memgraph.buildClaude(raw)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/claude/memory/search", apiPerm("claude.memory.read"), async (req, res) => {
  const q = String(req.query.q || "").slice(0, 500).trim();
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  const project = String(req.query.project || "").slice(0, 61).trim();
  try {
    const out = await priv.ccMemorySearch(q, 30, project && CC_SLUG.test(project) ? project : null);
    res.json({ hits: memgraph.claudeHits(out.results), timing_ms: out.timing_ms || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/claude/memory/fact/:id(\\d+)", apiPerm("claude.memory.read"), async (req, res) => {
  try {
    res.json(priv.redactDeep(await priv.ccFactGet(req.params.id)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

/** The agents whose memory this actor may read: all in scope, or one. */
async function memoryAgents(req, which) {
  const all = scopeAgents(req, await priv.agentList());
  if (!which || which === "all") return all.slice(0, 24);
  if (!SLUG_RE.test(which)) return [];
  return all.filter((a) => a.slug === which);
}

app.get("/api/agents/memory/graph", apiPerm("agents.memory.read"), async (req, res) => {
  try {
    const agents = await memoryAgents(req, String(req.query.agent || "all"));
    const vaults = await Promise.all(
      agents.map((a) =>
        priv
          .agentMemoryGraph(a.slug)
          .then((graph) => ({ slug: a.slug, name: a.name || a.slug, graph }))
          .catch((e) => ({ slug: a.slug, name: a.name || a.slug, error: e.message }))
      )
    );
    res.json(priv.redactDeep(memgraph.buildAgents(vaults)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/agents/memory/search", apiPerm("agents.memory.read"), async (req, res) => {
  const q = String(req.query.q || "").slice(0, 500).trim();
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  try {
    const agents = await memoryAgents(req, String(req.query.agent || "all"));
    const per = await Promise.all(
      agents.map((a) =>
        priv
          .agentMemorySearch(a.slug, q)
          .then((hits) => memgraph.agentHits(a.slug, hits))
          .catch(() => [])
      )
    );
    const hits = [].concat(...per).sort((x, y) => (y.score || 0) - (x.score || 0));
    res.json({ hits: priv.redactDeep(hits) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/agents/:slug/memory/note", apiPerm("agents.memory.read"), async (req, res) => {
  const slug = String(req.params.slug || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return res.status(404).json({ error: "No such agent." });
  try {
    const file = await priv.agentReadFile(slug, String(req.query.path || ""));
    const content = String(file.content || "");
    res.json(priv.redactDeep({ path: file.path, content: content.slice(0, 6000), truncated: content.length > 6000 }));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get("/claude", requireAuth, (req, res) => res.redirect("/claude/memory"));

app.get("/claude/memory", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const query = String(req.query.q || "").slice(0, 500).trim();
  const searchProject = String(req.query.sproject || "").slice(0, 61).trim();
  const filters = {
    topic: String(req.query.topic || "").slice(0, 121).trim(),
    project: String(req.query.project || "").slice(0, 61).trim(),
    superseded: req.query.sup === "1",
    kind: /^[a-z_]{1,20}$/.test(String(req.query.kind || "")) ? String(req.query.kind) : "",
    q: String(req.query.fq || "").slice(0, 200).trim(),
    page: qint(req.query.page, 1),
    per_page: 25,
  };
  const data = await gather({
    stats: () => priv.ccMemoryStats(),
    outline: () => priv.ccMemoryOutline(),
    recent: () => priv.ccFactsList({ page: 1, per_page: 10 }),
    // Browse lists the Telegram agents' memories too, for whoever may read them.
    memAgents: () =>
      req.perm.can("agents.memory.read")
        ? priv.agentList().then((list) => scopeAgents(req, list).filter((a) => req.perm.canAgent("agents.memory.read", a.slug)))
        : Promise.resolve([]),
    facts: () => priv.ccFactsList(filters),
    files: () => priv.ccMemfilesList(),
    hooks: () => priv.ccHooksTail(50),
    services: () => priv.ccMemoryServices(),
    search: () => (query ? priv.ccMemorySearch(query, 12, searchProject || null) : Promise.resolve(null)),
    mm: () => priv.ccMmSessions(),
  });
  const asked = String(req.query.view || "");
  const mmQuery = {
    q: String(req.query.sq || "").slice(0, 120).trim(),
    sort: String(req.query.sort || ""),
    dir: String(req.query.dir || ""),
  };
  const filtered = query || filters.topic || filters.project || filters.kind || filters.q || filters.superseded || filters.page > 1;
  res.send(
    claudeViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      view: claudeViews.MEMORY_VIEWS.some((v) => v[0] === asked) ? asked : filtered ? "list" : "browse",
      mmQuery,
      mmErr: data.errors && data.errors.mm,
      query,
      searchProject,
      filters,
      ...data,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.get("/claude/memory/facts/:id(\\d+)", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  try {
    const data = await priv.ccFactGet(req.params.id);
    res.send(
      claudeViews.fact({
        csrf: res.locals.csrf,
        user: ctx(req),
        data,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/facts", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccFactAdd({
      content: String(req.body.content || ""),
      topic: field(req.body, "topic"),
      kind: field(req.body, "kind"),
      project: field(req.body, "project"),
      actor: ccActor(req),
    });
    const similar = (out.similar || []).map((s) => "#" + s.id).join(", ");
    res.redirect(
      withMsg(
        "/claude/memory/facts/" + out.id,
        "msg",
        "Stored as fact #" + out.id + "." + (similar ? " Similar existing facts: " + similar + "." : "")
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/facts/:id(\\d+)/edit", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccFactEdit({
      id: Number(req.params.id),
      content: String(req.body.content || ""),
      topic: field(req.body, "topic"),
      kind: field(req.body, "kind"),
      actor: ccActor(req),
    });
    res.redirect(
      withMsg("/claude/memory/facts/" + out.id, "msg", "Saved as fact #" + out.id + "; #" + req.params.id + " is now superseded.")
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "err", e.message));
  }
});

app.post("/claude/memory/facts/:id(\\d+)/forget", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    await priv.ccFactForget({ id: Number(req.params.id), reason: field(req.body, "reason"), actor: ccActor(req) });
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "msg", "Forgotten. It will no longer be recalled."));
  } catch (e) {
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "err", e.message));
  }
});

app.get("/claude/memory/files/:project/:name", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const { project, name } = req.params;
  if (!CC_SLUG.test(project) || !CC_MEMFILE.test(name)) {
    return res.status(404).send(views.error("Not found", "No such memory file."));
  }
  try {
    const file = await priv.ccMemfileRead(project, name);
    res.send(
      claudeViews.memfile({
        csrf: res.locals.csrf,
        user: ctx(req),
        file,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/files/:project/:name", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  const { project, name } = req.params;
  if (!CC_SLUG.test(project) || !CC_MEMFILE.test(name)) {
    return res.status(404).send(views.error("Not found", "No such memory file."));
  }
  const back = "/claude/memory/files/" + encodeURIComponent(project) + "/" + encodeURIComponent(name);
  try {
    const out = await priv.ccMemfileWrite(project, name, String(req.body.content || ""), ccActor(req));
    const ingest = out.ingest || {};
    res.redirect(
      withMsg(
        back,
        "msg",
        "Saved. " + (ingest.started ? "Re-indexing in the background." : "Re-index not started: " + (ingest.reason || "unknown") + ".")
      )
    );
  } catch (e) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/restart", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    await priv.ccMemoryRestart(ccActor(req));
    res.redirect(withMsg("/claude/memory", "msg", "claude-memory restarted."));
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/ingest", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccIngestAll(ccActor(req));
    res.redirect(
      withMsg(
        "/claude/memory",
        out.started ? "msg" : "err",
        out.started ? "ingest.py --all started as cm-ingest (nice 10)." : "Not started: " + (out.reason || "unknown") + "."
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

/* ------------------------------------------------- memory by session --- */

/**
 * Memory > Sessions: one session's facts and chunks (claude.memory.read), and
 * hide / unhide / delete over them (claude.memory.manage, administrators only by
 * default). Every write goes through the helper, which keeps it inside the one
 * session, refuses whole-session changes to a live session, re-checks the
 * confirmed counts and audits counts only. A delete never happens on the first
 * POST: that renders the confirm page with the counts (or, for a whole session,
 * the name to type back), and only its own POST deletes.
 */
const MM_STATUS = ["", "active", "hidden", "superseded"];
const MM_SHOW = ["", "facts", "chunks"];
const MM_OPS = {
  "hide-items": ["hide", "items"],
  "unhide-items": ["unhide", "items"],
  "delete-items": ["delete", "items"],
  "hide-filtered": ["hide", "filtered"],
  "unhide-filtered": ["unhide", "filtered"],
  "delete-filtered": ["delete", "filtered"],
  "hide-session": ["hide", "session"],
  "unhide-session": ["unhide", "session"],
};

function mmFilters(src, prefix) {
  const g = (k) => String((src && src[(prefix || "") + k]) || "");
  const status = g("status");
  const show = g("show");
  const topic = g("topic").slice(0, 121).trim();
  return {
    q: g("q").slice(0, 200).trim(),
    topic: /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,120}$/.test(topic) ? topic : "",
    status: MM_STATUS.includes(status) ? status : "",
    show: MM_SHOW.includes(show) ? show : "",
  };
}

const mmIds = (v) =>
  []
    .concat(v == null ? [] : v)
    .map(String)
    .filter((x) => /^\d{1,15}$/.test(x))
    .map(Number)
    .slice(0, 20000);

function mmPath(uuid, filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) if (v) p.set(k, v);
  const q = p.toString();
  return "/claude/memory/session/" + uuid + (q ? "?" + q : "");
}

function mmMessage(out) {
  const n = (x, one) => `${x || 0} ${one}${x === 1 ? "" : "s"}`;
  if (out.action === "hide")
    return `Hidden: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}. They stay in the database and can be unhidden.`;
  if (out.action === "unhide") return `Unhidden: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}. They are recalled again.`;
  let m = `Deleted permanently: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}.`;
  if (out.hidden_older) m += ` ${n(out.hidden_older, "older version")} of deleted facts hidden.`;
  if (out.repointed) m += ` ${n(out.repointed, "older version")} now point at the surviving newer fact.`;
  return m;
}

app.get("/claude/memory/session/:uuid", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  let data = null;
  let err = null;
  try {
    data = await priv.ccMmSession(Object.assign({ session: uuid, page: qint(req.query.page, 1) }, mmFilters(req.query)));
  } catch (e) {
    err = e.message;
  }
  res.send(
    claudeViews.sessionMemory({
      csrf: res.locals.csrf,
      user: ctx(req),
      data,
      uuid,
      err: err || req.query.err || null,
      flash: req.query.msg || null,
    })
  );
});

app.post("/claude/memory/session/:uuid/apply", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  const filters = mmFilters(req.body, "f_");
  const back = mmPath(uuid, filters);
  const op = MM_OPS[String(req.body.op || "")];
  if (!op) return res.redirect(withMsg(back, "err", "Choose what to do with the selection."));
  const [action, scope] = op;
  const request = Object.assign({ session: uuid, action, scope }, scope === "filtered" ? filters : {});
  if (scope === "items") {
    request.facts = mmIds(req.body.f);
    request.chunks = mmIds(req.body.c);
    if (!request.facts.length && !request.chunks.length) return res.redirect(withMsg(back, "err", "Nothing is selected."));
  }
  try {
    if (action === "delete" && req.body.confirmed !== "1") {
      const preview = await priv.ccMmPreview(request);
      return res.send(claudeViews.mmConfirmDelete({ csrf: res.locals.csrf, user: ctx(req), uuid, preview, body: req.body }));
    }
    if (action === "delete") {
      const count = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : -1);
      request.expect = { facts: count(req.body.expect_facts), chunks: count(req.body.expect_chunks) };
    }
    const out = await priv.ccMmApply(Object.assign(request, { actor: ccActor(req) }));
    res.redirect(withMsg(back, "msg", mmMessage(out)));
  } catch (e) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/session/:uuid/delete", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  const back = mmPath(uuid);
  const confirmPage = async (err) => {
    const preview = await priv.ccMmPreview({ session: uuid, action: "delete", scope: "session" });
    if (preview.session && preview.session.live) throw new Error("This session is live (" + preview.session.live_reason + "); it cannot be deleted.");
    return claudeViews.mmConfirmSession({ csrf: res.locals.csrf, user: ctx(req), uuid, preview, err });
  };
  try {
    if (req.body.step !== "confirm") return res.send(await confirmPage(null));
    const out = await priv.ccMmDeleteSession({
      session: uuid,
      actor: ccActor(req),
      confirm: String(req.body.confirm || "").slice(0, 200),
      delete_files: req.body.delete_files === "1",
    });
    let m = `Session deleted from memory: ${out.facts} facts and ${out.chunks} chunks. It will not be indexed again.`;
    if (out.files_removed) m += ` ${out.files_removed} transcript file(s) deleted.`;
    if (out.files_kept_readonly) m += ` ${out.files_kept_readonly} read-only archive cop${out.files_kept_readonly === 1 ? "y" : "ies"} kept.`;
    if (out.files_error) m += " Transcript files: " + out.files_error;
    res.redirect(withMsg("/claude/memory?view=sessions", "msg", m));
  } catch (e) {
    if (req.body.step === "confirm" && /type the session's name/.test(e.message)) {
      try {
        return res.send(await confirmPage(e.message));
      } catch (_) {
        /* fall through to the redirect */
      }
    }
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/session/:uuid/reindex", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  try {
    const out = await priv.ccMmReindex({ session: uuid, actor: ccActor(req) });
    res.redirect(
      withMsg(mmPath(uuid), "msg", out.lifted ? "It may be indexed again: the next re-scan picks up any transcript left on disk." : "It was not excluded.")
    );
  } catch (e) {
    res.redirect(withMsg(mmPath(uuid), "err", e.message));
  }
});

/**
 * Agents & sessions ▸ Sessions: tabs Live (what was Claude Code ▸ Running, with
 * JOYA AI's view of each session on top), All and Archived (the transcripts).
 * ?archived=1 is the old spelling of the Archived tab.
 */
app.get("/claude/sessions", requireAuth, async (req, res) => {
  const canLive = req.perm.can("claude.running.view");
  const canAll = req.perm.can("claude.sessions.view");
  if (!canLive && !canAll) return res.status(403).send(views.error("Not allowed", "Your role does not include Claude Code sessions."));
  let tab = ["live", "all", "archived"].includes(req.query.tab) ? req.query.tab : req.query.archived === "1" ? "archived" : canLive ? "live" : "all";
  if (tab === "live" && !canLive) tab = "all";
  if (tab !== "live" && !canAll) tab = "live";
  const flash = req.query.msg || null;
  let err = req.query.err || null;

  if (tab === "live") {
    let r = null;
    try {
      r = await priv.ccRunning();
    } catch (e) {
      err = e.message;
    }
    const team = req.perm.can("joyaai.use") ? await sessionsTeam(req) : null;
    const live = team && !team.error ? team.sessions.filter((x) => !x.self).length : r ? (r.sessions || []).filter((x) => x.alive).length : null;
    return res.send(claudeViews.live({ csrf: res.locals.csrf, user: ctx(req), r, team, flash, err, counts: { live } }));
  }

  const filters = {
    home: CC_HOMES.has(String(req.query.home || "")) ? String(req.query.home) : "",
    project: CC_SLUG.test(String(req.query.project || "")) ? String(req.query.project) : "",
    q: String(req.query.q || "").slice(0, 200).trim(),
    archived: tab === "archived",
    page: qint(req.query.page, 1),
    per_page: 25,
  };
  let data = null;
  try {
    data = await priv.ccSessionsList(filters);
  } catch (e) {
    err = e.message;
  }
  res.send(claudeViews.sessions({ csrf: res.locals.csrf, user: ctx(req), data, filters, flash, err }));
});

/**
 * JOYA AI's view of the live sessions for Sessions ▸ Live and the Overview:
 * the supervisor's sessions (hired, kept, yours, itself) and each one's token
 * cap row, by cap key. { sessions, caps, error } -- never throws.
 */
async function sessionsTeam(req) {
  try {
    const [s, c] = await Promise.all([
      joyaai.call("sessions", {}, req.me.username),
      joyaai.call("token-caps", {}, req.me.username).catch(() => null),
    ]);
    const caps = {};
    for (const row of (c && c.sessions) || []) caps[row.key] = row;
    return { sessions: (s && s.sessions) || [], caps, error: null, max_live: null };
  } catch (e) {
    return { sessions: [], caps: {}, error: "JOYA AI is not reachable: " + e.message };
  }
}

/* Sessions ▸ Live, the forms behind Keep / Stop keeping / Retire… / Resume (the
   Command Center does the same through /joya-ai/api/sessions/...). */
const liveBack = (res, kind, text) => res.redirect(303, "/claude/sessions?tab=live&" + kind + "=" + encodeURIComponent(text) + "#s-live");
app.post("/claude/sessions/live/:slug/keep", requireAuth, requirePerm("joyaai.use"), requireCsrf, async (req, res) => {
  const slug = /^[a-z0-9][a-z0-9-]{0,39}$/.test(req.params.slug) ? req.params.slug : null;
  if (!slug) return liveBack(res, "err", "No such session.");
  const kept = field(req.body, "kept") === "1";
  try {
    await joyaai.call("session-keep", { slug, kept }, req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ai", `${kept ? "kept" : "unkept"} hired session ${slug}`);
    liveBack(res, "msg", kept ? "Kept: JOYA AI can never retire it." : "No longer kept.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
});
// Both forms carry data-step-up: public/step-up.js asks for Windows Hello and posts the proof with them.
const liveStepRefuse = (req, res, msg) => liveBack(res, "err", msg + " (Windows Hello needs JavaScript on this page.)");
app.post("/claude/sessions/live/:slug/retire", requireAuth, requirePerm("joyaai.use"), requireCsrf, retireStepUp(liveStepRefuse), async (req, res) => {
  const slug = /^[a-z0-9][a-z0-9-]{0,39}$/.test(req.params.slug) ? req.params.slug : null;
  if (!slug) return liveBack(res, "err", "No such session.");
  try {
    await callStepped(req, "session-retire", { slug }, { timeout: 60000 });
    db.logLogin(req.ip, req.me.username, "joya-ai", `retired hired session ${slug}${steppedWith(req)}`);
    liveBack(res, "msg", "Retired. Its transcript is kept.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
});
const resumeKeyOf = (req) => {
  const key = String(field(req.body, "key") || "");
  return /^[A-Za-z0-9<>._:-]{1,80}$/.test(key) ? key : null;
};
const liveResumeStepUp = stepup.requireStepUp({
  bind: (req) => (resumeKeyOf(req) ? "resume:" + resumeKeyOf(req) : null),
  what: () => "Resume past the daily cap",
  audit: stepAudit,
  html: liveStepRefuse,
});
app.post("/claude/sessions/live/resume", requireAuth, requirePerm("joyaai.use"), requireCsrf, liveResumeStepUp, async (req, res) => {
  if (!req.perm.admin) return liveBack(res, "err", "Resuming past a cap is the administrator's.");
  const key = String(field(req.body, "key") || "");
  if (!/^[A-Za-z0-9<>._:-]{1,80}$/.test(key)) return liveBack(res, "err", "No such session.");
  try {
    await callStepped(req, "budget-resume", { key });
    db.logLogin(req.ip, req.me.username, "joya-ai", `resumed ${key} past its daily cap${steppedWith(req)}`);
    liveBack(res, "msg", "Resumed for the rest of today.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
});

app.get("/claude/sessions/:home/:uuid", requireAuth, requirePerm("claude.sessions.view"), ccSessionParams, async (req, res) => {
  const agent = String(req.query.agent || "");
  if (agent && !CC_AGENT.test(agent)) return res.status(404).send(views.error("Not found", "No such subagent."));
  try {
    const s = await priv.ccSessionGet(req.params.home, req.params.uuid, {
      page: req.query.page ? qint(req.query.page, 1) : null,
      agent: agent || null,
      archived: req.query.archived === "1",
    });
    res.send(
      claudeViews.session({
        csrf: res.locals.csrf,
        user: ctx(req),
        s,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/sessions", "err", e.message));
  }
});

const ccSessionPath = (req, archived) =>
  "/claude/sessions/" + req.params.home + "/" + req.params.uuid + (archived ? "?archived=1" : "");

app.post("/claude/sessions/:home/:uuid/rename", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionRename(req.params.home, req.params.uuid, field(req.body, "title"), ccActor(req));
    res.redirect(withMsg(ccSessionPath(req), "msg", "Renamed."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req), "err", e.message));
  }
});

app.post("/claude/sessions/:home/:uuid/archive", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionArchive(req.params.home, req.params.uuid, ccActor(req));
    res.redirect(withMsg(ccSessionPath(req, true), "msg", "Archived. Nothing was deleted; Restore moves it back."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req), "err", e.message));
  }
});

app.post("/claude/sessions/:home/:uuid/restore", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionRestore(req.params.home, req.params.uuid, ccActor(req));
    res.redirect(withMsg(ccSessionPath(req), "msg", "Restored to its project folder."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req, true), "err", e.message));
  }
});

// What was Claude Code ▸ Running is Sessions ▸ Live.
app.get("/claude/running", requireAuth, (req, res) => {
  const q = new URLSearchParams({ tab: "live" });
  if (req.query.msg) q.set("msg", String(req.query.msg));
  if (req.query.err) q.set("err", String(req.query.err));
  res.redirect(302, "/claude/sessions?" + q.toString());
});

// Polled by public/app.js every 10 s. The fragments are rendered here, by the
// same functions as the page, so there is one template and the browser only
// swaps markup that was already escaped.
app.get("/api/claude/running", requireAuth, requirePerm("claude.running.view"), async (req, res) => {
  try {
    const r = await priv.ccRunning();
    res.json({
      ts: r.ts,
      updated: String(r.ts || "").replace("T", " ").slice(0, 19),
      html: claudeViews.runningSections(res.locals.csrf, ctx(req), r),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/claude/running/stop", requireAuth, requirePerm("claude.running.stop"), requireCsrf, async (req, res) => {
  const pid = Number(field(req.body, "pid"));
  if (!Number.isInteger(pid) || pid <= 1) return res.redirect(withMsg("/claude/sessions?tab=live", "err", "Bad pid."));
  const force = field(req.body, "force") === "1";
  try {
    const out = await priv.ccStop(pid, force, ccActor(req));
    res.redirect(
      withMsg(
        "/claude/sessions?tab=live",
        "msg",
        out.signal + " sent to pid " + pid + "." + (force ? "" : " If it is still running in 10 seconds, Force stop appears.")
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/sessions?tab=live", "err", e.message));
  }
});

/* ---------------------------------------------------------------- guide --- */

app.get("/guide", requireAuth, (req, res) => {
  res.send(
    guideViews.guide({
      csrf: res.locals.csrf,
      user: ctx(req),
      publicHost: PUBLIC_HOST,
      publicPort: PUBLIC_PORT,
      sshHost: process.env.JOYA_SSH_HOST || PUBLIC_HOST,
    })
  );
});

/* ------------------------------------------------ JOYA AI ▸ Settings ---- */
/*
 * /joya-ai/settings/<section> (lib/routes-settings.js, views lib/views-settings.js).
 * The Voice section's renderer and routes sit with the voice code below it.
 */
// The page map (Settings > Screen control): scanned now, and again on Rescan pages.
const pageMap = require("./lib/page-map");
pageMap.configure({ db, joyaai });
try {
  pageMap.scan("panel start");
} catch (e) {
  console.error("page map: the scan failed, page.open keeps its built-in pages: " + e.message);
}
settingsRoutes.mount(app, { requireAuth, requireCsrf, ctx, db, joyaai, pageMap, voicePublic, voiceSpend: () => voiceUsageSummary(), stepup, stepAudit, callStepped, steppedWith, desktopDays: () => desktop.days(), desktopSetDays: (d, by) => desktop.setDays(d, by) });

/* --------------------- JOYA AI, proactive: the brief, watchers, catch-up ---- */
/*
 * lib/routes-proactive.js (pure part lib/proactive.js, rows lib/proactive-store.js, the model's
 * wording lib/proactive-writer.js; the page's half public/joya-proactive.js). Its clock runs here.
 */
const proactive = require("./lib/routes-proactive").mount(app, {
  requireAuth,
  requireCsrf,
  apiGuard: joyaAiGuard,
  apiWrite: joyaAiWrite,
  db,
  joyaai,
  rbac,
  settingsRoutes,
  tickMs: Number(process.env.JOYA_PROACTIVE_TICK_MS) || undefined,
  wsBase: process.env.JOYA_OPENAI_WS || undefined,
  voice: { enabled: () => voiceEnabled(), config: () => voiceConfig(), record: (row) => recordVoice(() => voiceLedger.add(row).usd) },
});

/* ------------------------------------- the living canvas (the board) ---- */
/*
 * lib/routes-canvas.js (rows lib/canvas-store.js; the page's half public/joya-canvas.js with the
 * building blocks public/joya-widgets.js and the layout policy public/joya-canvas-policy.js).
 */
const canvas = require("./lib/routes-canvas").mount(app, { requireAuth, requireCsrf, apiGuard: joyaAiGuard, apiWrite: joyaAiWrite, db, settingsRoutes });

/*
 * Files attached to a message to JOYA AI (2026-10-25): lib/uploads.js keeps them under
 * <data dir>/uploads/<day>/<message>/, lib/routes-uploads.js takes and serves them; /joya-ai/api/send
 * turns a message's ids into its "[Attached file: …]" lines.
 */
const uploads = require("./lib/uploads").create({ root: process.env.JOYA_UPLOAD_DIR || path.join(DATA_DIR, "uploads") });
require("./lib/routes-uploads").mount(app, { apiGuard: joyaAiGuard, apiWrite: joyaAiWrite, express, uploads, db });

/* ------------------------------------- Computers (laptop control) ---- */
/*
 * The user's own computers, linked through the JOYA AI desktop app (lib/machines.js, routes
 * lib/routes-machines.js, views lib/views-machines.js; the supervisor's half joya-ai/lib/machines.js).
 */
const machines = require("./lib/machines").create({
  db: db.db,
  dir: process.env.JOYA_MACHINES_DIR || path.join(DATA_DIR, "machines"),
  call: (op, params, actor, opts) => joyaai.call(op, params, actor, opts),
  subscribe: (since, actor, onEvent, onEnd) => joyaai.subscribe(since, actor, onEvent, onEnd),
  redact: (s) => priv.redact(String(s || "")),
});
machines.start();
const machineLink = require("./lib/routes-machines").mount(app, { machines, requireAuth, requirePerm, requireCsrf, ctx, db, rateLimit, WebSocketServer });

/* ------------------------------------------ the voiceprint (live voice) -- */

// lib/voiceprint.js: the live relay checks each turn against the enrolled voiceprint through the
// local joya-voiceprint service (Settings ▸ Voice ▸ Voiceprint: On / Off, and "Only respond to my
// voice"). The print is sealed by the helper; this process holds it open only in memory.
vprint = voiceprintLib.createVoiceprint({
  db,
  priv,
  dataDir: DATA_DIR,
  log: (m) => console.log(m),
  parseWav: voiceprintTrial.parseWav,
  userById: (id) => db.getUser(id),
});
voiceprintRoutes.mount(app, { vprint, trial: voiceprintTrial, settingsGuard: voiceGuardSettings, reply: (req, res, o) => voiceReply(req, res, o), requireAuth, requirePerm, requireApiPerm, requireApiCsrf, rateLimit, express, db, ctx, views: voiceprintEnrolViews, asset });
if (vprint.enabled()) vprint.health().catch(() => {});
vprint.openAll().catch(() => {}); // opens (and, once, migrates) the stored voiceprints

/* --------------------------------------------------------------- misc ----- */

app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.use((req, res) => res.status(404).send(views.error("Not found", "No such page.")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(views.error("Server error", "Something went wrong."));
});

/* ------------------------------------------- live conversation (WS) ---- */

/**
 * Live conversation (lib/voice-live.js): the Command Center streams the
 * microphone here over a WebSocket, and this server relays it to OpenAI's
 * realtime model and plays back only what the guard has passed. The browser
 * never talks to OpenAI and never sees the key.
 *
 * GET /joya-ai/api/live?csrf=<token> (Upgrade: websocket). Refused, before
 * the upgrade, unless all of these hold:
 *   - the Origin is this host (a page elsewhere cannot open it with the cookie);
 *   - a signed-in session (the same cookie and store as every page), a user
 *     who is not disabled, with joyaai.use AND voice.use (administrators by default);
 *   - the session's CSRF token in the query;
 *   - voice is on (Settings ▸ Voice; 403 while it is off) and an OpenAI key is set.
 * Then: one live call per user (a second is told "busy" and closed), at most
 * LIVE_MAX_CALLS at once, 20 minutes at most (lib/voice-live.js), frames of at
 * most half a second of audio or 4 KB of JSON, and no more audio than twice
 * real time. A keep-alive ping every 15 s keeps nginx's 60 s read timeout from
 * cutting a quiet call.
 *
 * Wire: page -> server: binary PCM16 mono 24 kHz; JSON {type: "played"|
 * "flushed"|"mute"|"end"}. server -> page: binary [uint32 LE seg][PCM16];
 * JSON {type: "ready"|"state"|"seg"|"segend"|"cut"|"flush"|"caption"|"asked"|
 * "replied"|"stop"|"ended"|"error"}. See the README's integration contract.
 */
const LIVE_PATH = /^\/(?:joya)-ai\/api\/live(?:\?|$)/;
const LIVE_MAX_CALLS = 4;
const LIVE_MAX_FRAME = voiceLive.RATE; // bytes: half a second of PCM16
function liveAllowed(perm) {
  return voiceAllowed(perm);
}
function hostOnly(h) {
  return String(h || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}
/** The Origin must be this very host (by name; nginx sends Host without the port). */
function liveOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let u;
  try {
    u = new URL(origin);
  } catch (_) {
    return false;
  }
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return false;
  return hostOnly(u.host) === hostOnly(req.headers.host);
}
function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function refuseUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } catch (_) {
    /* gone */
  }
  socket.destroy();
}
const liveWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

function liveUpgrade(req, socket, head) {
  if (!LIVE_PATH.test(req.url || "")) return refuseUpgrade(socket, 404, "Not Found");
  if (!liveOriginOk(req)) return refuseUpgrade(socket, 403, "Forbidden origin");
  sessionMw(req, {}, async () => {
    try {
      const sess = req.session;
      const me = sess && sess.authed && sess.userId ? db.getUser(sess.userId) : null;
      if (!me || me.disabled) return refuseUpgrade(socket, 401, "Unauthorized");
      const perm = rbac.actor(me.role);
      if (!liveAllowed(perm)) return refuseUpgrade(socket, 403, "Forbidden");
      const q = new URL(req.url, "http://x").searchParams;
      if (!sameToken(q.get("csrf"), sess.csrf)) return refuseUpgrade(socket, 403, "Invalid CSRF token");
      if (!voiceEnabled()) return refuseUpgrade(socket, 403, "Voice is off");
      const cfg = await voiceConfig();
      if (!cfg.key) return refuseUpgrade(socket, 409, "No OpenAI key");
      if (voiceLive.activeCount() >= LIVE_MAX_CALLS && !voiceLive.callFor(me.username)) return refuseUpgrade(socket, 503, "Too many live calls");
      const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const ip = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "") && fwd ? fwd : req.socket.remoteAddress;
      const audio = liveAudio();
      const duplex = voiceLive.DUPLEX.includes(q.get("duplex")) ? q.get("duplex") : audio.duplex;
      const route = q.get("route") === "loopback" ? "loopback" : q.get("route") === "direct" ? "direct" : "unknown";
      const tab = q.get("tab") || null;
      const sid = req.sessionID || null; // the device's session: signing it out ends this call (endLiveCallsForSession)
      // The page coming back after the dashboard restarted (it was told "restarting"): the voice says it is back.
      const resume = q.get("resume") === "restart" ? { lang: q.get("lang") === "ar" ? "ar" : "en" } : null;
      // Hold-to-talk turns (the desktop app's key): "ptt"; anything else is the live conversation as always.
      const turn = q.get("turn") === "ptt" ? "ptt" : "vad";
      liveWss.handleUpgrade(req, socket, head, (ws) => liveConnected(ws, { me, cfg, ip, duplex, noise: audio.noise, route, tab, canVoice: perm.can("voice.manage"), sid, resume, turn }));
    } catch (e) {
      console.log("live: upgrade failed: " + e.message);
      refuseUpgrade(socket, 500, "Server error");
    }
  });
}

function liveConnected(ws, { me, cfg, ip, duplex, noise, route, tab, canVoice, sid, resume, turn }) {
  const actor = me.username;
  const json = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (voiceLive.callFor(actor)) {
    json({ type: "error", code: "busy", error: "You already have a live conversation open (another tab?). End it there first." });
    return ws.close(4409, "busy");
  }
  // The voice model decides the class: GPT-Live (its own protocol, JOYA AI behind it) or the realtime call.
  const Call = voice.protocolFor(cfg.live_model) === "live" ? voiceGptLive.GptLiveCall : voiceLive.LiveCall;
  const call = new Call({
    cfg: { ...liveCfgOf(cfg), noise_reduction: noise },
    actor,
    ops: voiceShared.voiceOps(joyaCall, actor),
    client: {
      json,
      audio: (seg, buf) => {
        if (ws.readyState !== 1) return;
        const h = Buffer.alloc(4);
        h.writeUInt32LE(seg >>> 0, 0);
        ws.send(Buffer.concat([h, buf]));
      },
      close: (code, why) => {
        try {
          ws.close(code || 1000, String(why || "").slice(0, 100));
        } catch (_) {
          /* closed */
        }
      },
    },
    persona: () => personaOf(me.id),
    hearPersona: (text) => personaHear({ userId: me.id, username: actor, ip }, text),
    audit: (line) => db.logLogin(ip, actor, "joya-ui", line),
    speak: voice.speakStream,
    // The full-turn transcript (gpt-4o-transcribe), on the realtime models only: on GPT-Live, GPT-Live's own
    // input transcript is the request (lib/voice-gptlive.js), and no transcription model is called.
    transcribe: Call === voiceGptLive.GptLiveCall ? null : voiceTranscribe.transcribeFull,
    summarise: (id, o) => voiceShared.summariserFor(actor, cfg, joyaCall, { log: (m) => console.log(m) }).summarise(id, o),
    record: (row) => recordVoice(() => voiceLedger.add(row).usd),
    isStop: (t) => voiceStop.heard(t),
    isUndo: (t) => voiceStop.undo(t),
    // A hand-off to JOYA AI carries a ui token for the tab that holds the call (UI control Phase 2).
    uiTicket: () => uiRelay.joya({ actor, tab, via: "live", callId: call.id }),
    // Tier 2: asked for by the live voice, confirmed by a click or the next "yes" this server hears.
    openConfirm: (v) => uiConfirmOpen({ username: actor, ip, canVoice }, v, tab, "the live voice"),
    confirmHeard: (text) => uiConfirmHeard({ username: actor, ip }, text, "live call"),
    confirmPending: () => !!uiConfirms.pending(actor),
    // A whole yes / no (either language): checked against a pending confirm even just after the voice.
    isYesNo: (text) => voiceStop.yes(text) || voiceStop.no(text),
    // The confirm's 30 s start when the voice has finished asking.
    armConfirm: (id) => uiConfirms.arm(actor, id),
    log: (m) => console.log(m),
    // JOYA AI's text as it is written (the supervisor's event stream), for speaking a hand-off's reply
    // while it is written; the whole text so far is redacted again (a secret can straddle two deltas).
    // (since: the largest seq, so the supervisor replays none of its past events: only what comes next.)
    watchTurns: (onEvent) => joyaai.subscribe(Number.MAX_SAFE_INTEGER, actor, onEvent, () => {}),
    redact: (text) => priv.redact(String(text || "")),
    // The voiceprint (lib/voiceprint.js): read per turn, so Settings changes apply from the next one.
    voiceprint: vprint
      ? {
          enabled: () => vprint.enabled(),
          gate: () => vprint.gate(),
          hasPrints: () => vprint.hasPrints(),
          check: (pcm, o) => vprint.check(pcm, o),
          record: (row) => vprint.ledger({ ...row, actor }),
          learnTts: (v, pcm) => vprint.learnTts(v, pcm),
        }
      : null,
    opts: { duplex, turn: turn === "ptt" ? "ptt" : "vad" },
  });
  // Open the voiceprint now, so the first turn does not wait for the helper.
  if (vprint && vprint.enabled()) vprint.openAll().catch(() => {});
  call.sid = sid || null;
  voiceLive.register(actor, call);
  db.logLogin(ip, actor, "voice", `live conversation started (${turn === "ptt" ? "hold-to-talk, " : ""}${duplex === "full" ? "headphones" : "speakers"} mode, playback ${route}, noise reduction ${noise})`);
  console.log(`live: call ${call.id} started${call.kind === "gpt-live" ? " on GPT-Live" : ""}: ${turn === "ptt" ? "hold-to-talk, " : ""}${duplex} mode, playback ${route}, noise reduction ${noise}${resume ? ", resumed after a restart" : ""}`);
  // Twice real time is the most a microphone can send; more is not a microphone.
  let window0 = Date.now();
  let bytes = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length > LIVE_MAX_FRAME) return call.close("refused", "A frame was too large.");
      if (Date.now() - window0 > 5000) {
        window0 = Date.now();
        bytes = 0;
      }
      bytes += buf.length;
      if (bytes > voiceLive.RATE * 2 * 5 * 2) return call.close("refused", "Too much audio.");
      return call.audioIn(buf);
    }
    if (data.length > 4096) return;
    let m = null;
    try {
      m = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    call.message(m);
  });
  const ping = setInterval(() => {
    try {
      ws.ping();
    } catch (_) {
      /* closed */
    }
  }, 15000);
  // The page's socket closed. A call it ended itself ({type: "end", why}) is already closed with its
  // reason; anything else (a tab killed, a network drop, a reload without the unload beacon) is
  // "page-closed", with the close code -- not "hung-up", which is only ever the page's own end.
  ws.on("close", (code, reason) => {
    clearInterval(ping);
    if (!call.closed) call.close("page-closed", undefined, "code " + code + (reason && reason.length ? " " + JSON.stringify(String(reason).slice(0, 60)) : ""));
    voiceLive.unregister(actor, call);
    const dg = call.diag;
    const end = call.endWhy || { why: "ended", detail: "" };
    db.logLogin(ip, actor, "voice", `live conversation ended (${end.why}${end.detail ? ": " + end.detail : ""}) after ${Math.round((Date.now() - call.bornAt) / 1000)} s, $${call.usd.toFixed(4)}; ${call.duplex} mode, barge-ins ${dg.bargeIns.length} of ${dg.candidates.length} candidates, phantom turns ${dg.leaks}, upstream reconnects ${dg.drops.length}`);
  });
  ws.on("error", () => {});
  call
    .connect()
    .then(() => {
      json({ type: "ready", call: call.id, model: call.model, voice: cfg.voice, max_s: Math.round(call.opts.maxMs / 1000), rate: voiceLive.RATE, duplex: call.duplex, noise, resumed: !!resume, turn: call.turnMode });
      if (resume) call.sayReconnected(resume.lang);
    })
    .catch((e) => {
      json({ type: "error", code: "upstream", error: voice.scrub(e.message) });
      call.close("upstream", voice.scrub(e.message), "could not connect");
    });
}

/**
 * End every live call bound to this browser session (its id, req.sessionID):
 * signing a device out ends that device's call -- the logout here, and the
 * Devices page's sign-out of another device. Returns how many were ended.
 */
function endLiveCallsForSession(sid, reason) {
  if (!sid) return 0;
  let n = 0;
  for (const call of voiceLive.all()) {
    if (call.sid !== sid) continue;
    try {
      call.close(reason || "signed-out");
      n++;
    } catch (e) {
      console.log("live: could not end a call on sign-out: " + e.message);
    }
  }
  return n;
}

const httpServer = app.listen(PORT, BIND, () => {
  console.log(`joya-dashboard listening on ${BIND}:${PORT}`);
  if (noUsersYet()) {
    // Materialise the token at startup so an operator with shell access can read
    // it, rather than having to hit the endpoint first to bring it into being.
    getSetupToken();
    console.log("No admin account yet. Setup token is in " + DATA_DIR + "/setup.token");
  }
  // Bring the helper's stored reader/listening models in line with the settings once.
  migrateVoiceHelperModels();
  // Which voice models the key reaches (GPT-4o Mini Realtime is offered only when listed).
  checkVoiceAccess({ force: true }).catch(() => {});
});
// A computer's link (lib/routes-machines.js) or the live conversation.
httpServer.on("upgrade", (req, socket, head) => (machineLink.isLink(req) ? machineLink.upgrade(req, socket, head) : liveUpgrade(req, socket, head)));

/* ------------------------------------------- restarts and deploys ---- */

/**
 * The open live calls, in a file the deploy scripts read before they restart
 * anything (deploy/deploy-dashboard.sh and deploy-joya-ai.sh warn about open
 * calls). Rewritten whenever a call starts or ends; {count: 0} at start.
 */
const LIVE_STATUS_FILE = path.join(DATA_DIR, "live-calls.json");
function writeLiveStatus() {
  try {
    fs.writeFileSync(LIVE_STATUS_FILE + ".tmp", JSON.stringify({ count: voiceLive.activeCount(), calls: voiceLive.status(), pid: process.pid, at: new Date().toISOString() }) + "\n", { mode: 0o640 });
    fs.renameSync(LIVE_STATUS_FILE + ".tmp", LIVE_STATUS_FILE);
  } catch (e) {
    console.log("live: could not write " + LIVE_STATUS_FILE + ": " + e.message);
  }
}
voiceLive.setOnChange(writeLiveStatus);
writeLiveStatus();

/**
 * SIGTERM (systemctl restart / stop, a deploy): every live call's page is told
 * {type: "restarting"} before its call ends, and reconnects by itself with
 * backoff once the new process listens. Then this process exits.
 */
let stopping = false;
function stopGracefully(sig) {
  if (stopping) return;
  stopping = true;
  const n = voiceLive.restartAll(); // (rewrites the status file only when calls were open)
  if (!n) process.exit(0); // nothing to tell: stop at once, as before this handler existed
  console.log(`joya-dashboard: ${sig}; ${n} live call(s) told the dashboard is restarting`);
  try {
    httpServer.close();
  } catch (_) {
    /* already closing */
  }
  // A moment for the "restarting" frames and the close handshakes to leave.
  setTimeout(() => process.exit(0), 400).unref();
}
process.on("SIGTERM", () => stopGracefully("SIGTERM"));
process.on("SIGINT", () => stopGracefully("SIGINT"));

/**
 * JOYA AI hears that the dashboard (re)started, with what was deployed
 * (deploy-dashboard.sh writes DEPLOYED next to server.js: the commit and when):
 * the supervisor passes it on with JOYA AI's next turn. Retried while the
 * supervisor is not up.
 */
function deployedStamp(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^([a-z_]+)=([^\s]{1,80})$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch (_) {
    return {};
  }
}
function announceStart(tries) {
  const d = deployedStamp(path.join(__dirname, "DEPLOYED"));
  const params = { component: "dashboard", started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString() };
  if (d.commit && /^[0-9a-f]{7,40}$/.test(d.commit)) params.commit = d.commit;
  if (d.deployed_at && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d.deployed_at)) params.deployed_at = d.deployed_at;
  joyaai
    .call("deploy-event", params, "joya-dashboard", { timeout: 5000 })
    .catch((e) => {
      if (tries > 0 && !stopping) setTimeout(() => announceStart(tries - 1), 30000).unref();
      else console.log("joya-dashboard: JOYA AI was not told about this start (" + e.message + ")");
    });
}
if (process.env.JOYA_ANNOUNCE_START !== "0") setTimeout(() => announceStart(10), 2000).unref();

