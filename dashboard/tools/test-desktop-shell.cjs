#!/usr/bin/env node
"use strict";
/**
 * The JOYA AI desktop app's server side (lib/desktop.js, the ?shell=desktop
 * render mode, the desktop sign-in pages, the update feed) and its page side
 * (public/joya-desktop-layout.js, public/joya-desktop.js).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-shell.cjs [--shots DIR]
 *
 * Pure parts first (the layouts, the hit regions, the session length, the
 * one-time codes); then a scratch copy of the real server.js
 * (tools/scratch-server.cjs: the helper is blocked, the data dir is a temp
 * dir) over HTTP; then headless Chromium with a transparent background: the
 * three modes, focus mode, both inks, at the app's window sizes, plus the
 * download page at 1440 and 390, with zero CSP violations and page errors.
 * The browser's user agent carries "JoyaDesktop/0.1.0", as the app's does.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const LAY = require(path.join(ROOT, "public", "joya-desktop-layout.js"));
const DK = require(path.join(ROOT, "lib", "desktop.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.0";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.5);

(async () => {
  section("the layouts (public/joya-desktop-layout.js): the mockup's numbers");
  {
    const ws = LAY.windowSize({ mode: "floating", size: "M" });
    check("Floating M: a 480 x 580 box with 280 px of headroom above it for the card", ws.w === 480 && ws.h === 860 && ws.box.h === 580);
    check("  S and L scale it (0.8 / 1.22); focus mode is the core alone, 168 px, no headroom", LAY.windowSize({ size: "S" }).w === 384 && LAY.windowSize({ size: "L" }).w === 586 && LAY.windowSize({ focus: true }).w === 168 && LAY.windowSize({ focus: true }).h === 168);
    const f = LAY.layout({ mode: "floating", size: "M", W: 480, H: 860 });
    check("  the box sits at the bottom of the window; the core 36 % down it, radius 16.3 % of its width", f.box.y === 280 && near(f.cy, 280 + 580 * 0.36) && near(f.R, 480 * 0.163) && f.cx === 240);
    const rim = (deg) => [f.cx + (f.R * 1.02 + 8) * Math.cos((deg * Math.PI) / 180), f.cy + (f.R * 1.02 + 8) * Math.sin((deg * Math.PI) / 180)];
    check("  the chat (10°) and live-call (42°) buttons on the core's lower right rim; the chat panel under the pill, down to the box's bottom, 14 px in", near(f.chatBtn.x, rim(10)[0]) && near(f.chatBtn.y, rim(10)[1]) && near(f.liveBtn.x, rim(42)[0]) && near(f.liveBtn.y, rim(42)[1]) && f.chatBtn.d === 34 && f.liveBtn.d === 34 && f.panel.x === 14 && f.panel.w === 452 && f.panel.y > f.caption.y + 20 && near(f.panel.y + f.panel.h, 280 + 580 - 14) && f.composer === undefined && f.chat === undefined);
    check("  the card in the headroom, 10 px above the box, never over the core", f.card.bottom === 860 - 280 + 10 && f.card.y + f.card.h <= 280);
    const d = LAY.layout({ mode: "desktop", W: 1920, H: 1032 });
    check("Desktop layer: core 170 px at 56 % across (right), 42 % down; the panel (460 px) under it, inside the screen", near(d.R, 170) && near(d.cx, 1920 * 0.56) && near(d.cy, 1032 * 0.42) && d.tools === null && d.panel.w === 460 && d.panel.y > d.cy + d.R && d.panel.y + d.panel.h <= 1032 - 16 && near(d.panel.x + d.panel.w / 2, d.cx));
    check("  left / centre presets move it; the card top right", near(LAY.layout({ mode: "desktop", pos: "left", W: 1920, H: 1032 }).cx, 1920 * 0.36) && near(LAY.layout({ mode: "desktop", pos: "centre", W: 1920, H: 1032 }).cx, 960) && d.card.x === 1920 - 16 - 330 && d.card.y === 72);
    const p = LAY.layout({ mode: "peek", W: 1440, H: 900 });
    check("Peek: centred, 180 px, 40 % down; a 560 px panel under the core", p.cx === 720 && near(p.R, 180) && near(p.cy, 360) && p.panel.w === 560 && p.panel.y > p.cy + p.R && p.panel.y + p.panel.h <= 900 - 24);
    const tiny = LAY.layout({ mode: "desktop", W: 1024, H: 560 });
    check("  a small screen: no room under the core, so the panel goes beside it, on screen and clear of the core", tiny.panel.y >= 16 && tiny.panel.y + tiny.panel.h <= 560 - 16 && tiny.panel.x >= 16 && tiny.panel.x + tiny.panel.w <= 1024 - 16 && (tiny.panel.x + tiny.panel.w <= tiny.cx - tiny.R || tiny.panel.x >= tiny.cx + tiny.R), JSON.stringify(tiny.panel));
    const rg = LAY.regions(f, [{ left: 10, top: 10, width: 20, height: 10 }, { left: 0, top: 0, width: 0, height: 9 }, { left: 470, top: 850, width: 50, height: 50, r: 4 }]);
    check("the hit regions: the core as a circle first, empty boxes dropped, the rest clipped to the window", rg.length === 3 && rg[0].r === Math.round(f.R) && rg[0].w === rg[0].h && rg[2].x === 470 && rg[2].w === 10 && rg[2].h === 10);
    check("  'all': the whole window (Peek while it shows, a dialog open)", JSON.stringify(LAY.regions(f, [], { all: true })) === JSON.stringify([{ x: 0, y: 0, w: 480, h: 860, r: 0 }]));
    // The host sizes the Floating window with the same numbers.
    const rs = fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "layout.rs"), "utf8");
    check("  the app's own sizes (desktop/src-tauri/src/layout.rs) are the same: 480 x 580, 168, headroom 280, S/M/L", /BOX_W:\s*f64\s*=\s*480\.0/.test(rs) && /BOX_H:\s*f64\s*=\s*580\.0/.test(rs) && /FOCUS:\s*f64\s*=\s*168\.0/.test(rs) && /HEADROOM:\s*f64\s*=\s*280\.0/.test(rs) && /0\.8/.test(rs) && /1\.22/.test(rs));
  }

  section("real blur: which glass surfaces the page reports (JoyaDesktopLayout.glass)");
  {
    const S = LAY.GLASS_SETTLE_MS;
    const panel = { key: "g1", x: 14.2, y: 400, w: 452, h: 446, r: 18 };
    let g = LAY.glass(null, [panel], 1000);
    check("a surface seen once is not reported yet (it may still be sliding in)", g.rects.length === 0 && g.keys.length === 0);
    g = LAY.glass(g.state, [panel], 1000 + S);
    check("  the same rectangle again, settle time later: reported, rounded to half pixels", g.rects.length === 1 && g.keys[0] === "g1" && g.rects[0].x === 14 && g.rects[0].w === 452 && g.rects[0].r === 18, JSON.stringify(g.rects));
    const moved = { ...panel, y: 396 };
    g = LAY.glass(g.state, [moved], 1000 + 2 * S);
    check("  it moves: dropped at once, back once it holds still", g.rects.length === 0 && LAY.glass(g.state, [moved], 1000 + 3 * S).rects.length === 1);
    g = LAY.glass(LAY.glass(LAY.glass(null, [panel], 0).state, [panel], S).state, [], 2 * S);
    check("  it goes: dropped at once (no blur outlives its card)", g.rects.length === 0 && Object.keys(g.state.seen).length === 0);
    const pill = LAY.glass(LAY.glass(null, [{ key: "p", x: 0, y: 0, w: 90, h: 24, r: 999 }, { key: "z", x: 0, y: 0, w: 0, h: 10 }], 0).state, [{ key: "p", x: 0, y: 0, w: 90, h: 24, r: 999 }], S);
    check("  a radius past half the side is half the side (a pill); empty boxes are never reported", pill.rects.length === 1 && pill.rects[0].r === 12, JSON.stringify(pill.rects));
    const D = path.join(ROOT, "..", "desktop", "src-tauri");
    const remote = fs.readFileSync(path.join(D, "capabilities", "remote.json"), "utf8");
    const lib = fs.readFileSync(path.join(D, "src", "lib.rs"), "utf8");
    const acr = fs.readFileSync(path.join(D, "src", "acrylic.rs"), "utf8");
    check("the app: set_blur_rects is a command the site may call; it only stores rectangles (no window, no file)", /"allow-set-blur-rects"/.test(remote) && /"set_blur_rects"/.test(fs.readFileSync(path.join(D, "build.rs"), "utf8")) && /fn set_blur_rects\(rects: Vec<Region>, dpr: f64, view: Option<\(f64, f64\)>\) \{\s*acrylic::set_rects\(rects, dpr, view\);\s*\}/.test(lib));
    check("  the acrylic windows never take the focus or a click, follow the main window by its own messages (no polling), and use the accent that stays blurred when inactive", /WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE/.test(acr) && /MA_NOACTIVATE/.test(acr) && /WM_WINDOWPOSCHANGED/.test(acr) && /SetWindowSubclass/.test(acr) && /state: if on \{ 4 \}/.test(acr) && !/thread::sleep/.test(acr));
    check("  the page's glass flag comes from page_state (so the page and the native blur never disagree); the setting is on by default", /glass: blur_glass\(a, pm\.opacity\)/.test(lib) && /real_blur: true/.test(fs.readFileSync(path.join(D, "src", "settings.rs"), "utf8")));
  }

  section("lib/desktop.js: the app's user agent, session length, one-time codes");
  {
    check("the app is told from a browser by JoyaDesktop/<version> only", DK.appVersion({ headers: { "user-agent": APP_UA } }) === "0.1.0" && !DK.isApp({ headers: { "user-agent": WEB_UA } }) && !DK.isApp({ headers: { "user-agent": "JoyaDesktop/x" } }));
    check("days: whole, 1 to 90", DK.cleanDays("14") === 14 && DK.cleanDays(1) === 1 && DK.cleanDays(90) === 90 && DK.cleanDays(0) === null && DK.cleanDays(91) === null && DK.cleanDays("7.5") === null && DK.cleanDays("x") === null);
    const store = {};
    const fakeDb = { getSetting: (k, f) => (k in store ? store[k] : f), setSetting: (k, v) => (store[k] = v) };
    let t = 1_000_000_000_000;
    const d = DK.create({ db: fakeDb, dir: null, now: () => t });
    check("14 days by default; a setting changes it, a bad one does not", d.days() === 14 && d.setDays(30, "x") && d.days() === 30 && !d.setDays(500) && d.days() === 30);
    d.setDays(14);
    const mkReq = (ua) => ({ headers: { "user-agent": ua }, get: (h) => (h.toLowerCase() === "user-agent" ? ua : ""), session: { authed: true, authAt: t, cookie: { maxAge: 8 * 3600e3 } } });
    const rq = mkReq(APP_UA);
    check("a sign-in in the app: a desktop session of 14 days", d.markSession(rq) && rq.session.desktop && rq.session.cookie.maxAge === 14 * 86400e3);
    const wb = mkReq(WEB_UA);
    check("  in a browser: unchanged (8 h idle)", !d.markSession(wb) && !wb.session.desktop && wb.session.cookie.maxAge === 8 * 3600e3);
    t += 13 * 86400e3;
    check("  13 days on: still signed in, the cookie keeps the day that is left (counted from the sign-in, not the last request)", d.checkSession(rq) === "ok" && rq.session.cookie.maxAge === 86400e3);
    t += 86400e3 + 1;
    check("  after 14 days: expired", d.checkSession(rq) === "expired");
    check("  a browser session is never touched", d.checkSession(wb) === null);
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const code = d.issue(7, challenge);
    check("a code: 43 characters, for a well-formed challenge only", /^[A-Za-z0-9_-]{43}$/.test(code) && d.issue(7, "short") === null && d.issue(null, challenge) === null);
    check("  redeemed with the right secret: the user, once", d.redeem(code, verifier) === 7 && d.redeem(code, verifier) === null);
    const c2 = d.issue(8, challenge);
    check("  the wrong secret: refused, and the code is spent", d.redeem(c2, crypto.randomBytes(32).toString("base64url")) === null && d.redeem(c2, verifier) === null);
    const c3 = d.issue(9, challenge);
    t += DK.CODE_MS + 1;
    check("  after two minutes: gone", d.redeem(c3, verifier) === null && d.pending() === 0);
    check("feed file names: plain names only", !!DK.create({ db: fakeDb, dir: "/x" }).feedPath("JOYA AI_0.1.0_x64-setup.exe") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath("../latest.json") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath("a/b.exe") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath(".hidden.exe"));
  }

  const PW = process.env.PLAYWRIGHT || "playwright";
  let chromium = null;
  try {
    ({ chromium } = require(PW));
  } catch (e) {
    check("playwright found (set PLAYWRIGHT=/path/to/node_modules/playwright)", false, e.message);
  }

  const s = await scratch.startScratch({});
  const { authenticator } = require("otplib");
  try {
    section("the server: render mode, sign-in pages, session length (scratch copy, helper cut off)");
    const cookieOf = (res, prev) => {
      const set = res.headers["set-cookie"];
      if (!set) return prev;
      const jar = {};
      String(prev || "").split("; ").filter(Boolean).forEach((c) => (jar[c.split("=")[0]] = c));
      set.forEach((c) => { const kv = c.split(";")[0]; jar[kv.split("=")[0]] = kv; });
      return Object.values(jar).join("; ");
    };
    async function signIn(username, ua) {
      const u = users[username];
      const g = await s.req("GET", "/login", { headers: { "User-Agent": ua } });
      let cookie = cookieOf(g);
      const csrf = s.csrfOf(g.body);
      const p = await s.req("POST", "/login", { cookie, headers: { "User-Agent": ua }, body: new URLSearchParams({ _csrf: csrf, username, password: u.pw, token: authenticator.generate(u.secret) }).toString() });
      cookie = cookieOf(p, cookie);
      return { cookie, res: p };
    }
    const users = {};
    users.deskadmin = await s.makeUser("deskadmin", "administrator");
    users.webadmin = await s.makeUser("webadmin", "administrator");
    users.linker = await s.makeUser("linker", "administrator");

    const lw = await s.req("GET", "/login", { headers: { "User-Agent": WEB_UA } });
    check("a browser's sign-in page is unchanged (no desktop class, no hand-off)", lw.status === 200 && !/cc-desk/.test(lw.body) && !/dk-browser-signin/.test(lw.body) && /8 h idle/.test(lw.body));
    const la = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
    check("the app's sign-in page: the floating card, the browser hand-off, 14 days", /<html lang="en" class="cc-desk dk-auth">/.test(la.body) && /id="dk-browser-signin"/.test(la.body) && /stays signed in for 14 days/.test(la.body) && /joya-desktop\.js\?v=/.test(la.body));
    check("  its CSP adds only Tauri's IPC to connect-src; a browser's does not", /connect-src 'self' http:\/\/ipc\.localhost ipc:(;|$)/.test(la.headers["content-security-policy"]) && /connect-src 'self'(;|$)/.test(lw.headers["content-security-policy"]) && /script-src 'self';/.test(la.headers["content-security-policy"]), la.headers["content-security-policy"] + " | " + lw.headers["content-security-policy"]);

    // COOP same-origin stays for the app too: the start card's page and the site never share an opener, and 0.1.0 showed the site fine with it.
    check("  COOP is the same for the app and a browser (left as it is: it did not stop the app)", la.headers["cross-origin-opener-policy"] === lw.headers["cross-origin-opener-policy"]);
    const ping = await s.req("GET", "/desktop/ping", { headers: { "User-Agent": APP_UA } });
    check("/desktop/ping (the start card's probe): 204, CORP cross-origin, no-store, no cookie, no session", ping.status === 204 && ping.headers["cross-origin-resource-policy"] === "cross-origin" && /no-store/.test(ping.headers["cache-control"] || "") && !ping.headers["set-cookie"]);
    const startJs = fs.readFileSync(path.join(ROOT, "..", "desktop", "dist", "index.js"), "utf8");
    check("  the start card probes /desktop/ping and asks the app to navigate (go_site); it never sends the window to the site itself", /\/desktop\/ping/.test(startJs) && /invoke\("go_site"\)/.test(startJs) && !/location\.(replace|assign|href\s*=)\s*\(?\s*origin/.test(startJs));
    const libRs = fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
    check("  the app: go_site is a command, granted to the local pages only", /fn go_site\(/.test(libRs) && /"allow-go-site"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "local.json"), "utf8")) && !/go-site/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "remote.json"), "utf8")));
    // The 0.1.0 freeze: the lock held across a call the main thread answers. No `monitor_for(app, &a)` on a guard,
    // and nothing asks the main thread for monitors while the env loop's guard is held.
    check("  the app never asks the main thread for monitors while holding its lock (the 0.1.0 freeze)", !/monitor_for\(app, &a\)/.test(libRs) && !/let a = shared\.lock\(\)\.unwrap\(\);\s*monitor_for/.test(libRs) && /fn monitor_for\(app: &AppHandle, settings: &Settings\)/.test(libRs));
    // The "Not Responding" hang: the background loops never wait on the main thread.
    const fnBody = (name) => { const i = libRs.indexOf("fn " + name + "("); const j = libRs.indexOf("\nfn ", i + 3); return i < 0 ? "" : libRs.slice(i, j < 0 ? undefined : j); };
    const hitBody = fnBody("hit_loop"), envBody = fnBody("env_loop");
    check("  the click-through loop takes the lock with try_lock, reads the cursor and window from Windows, posts its changes (on_main)", /shared\.try_lock\(\)/.test(hitBody) && /platform::cursor\(\)/.test(hitBody) && /platform::window_rect\(raw\)/.test(hitBody) && /on_main\(/.test(hitBody) && !/cursor_position\(|outer_position\(|outer_size\(/.test(hitBody));
    check("  the environment loop posts window changes (on_main) and reads 'minimised' from Windows", /on_main\(/.test(envBody) && /platform::minimized\(raw\)/.test(envBody) && !/is_minimized\(/.test(envBody) && !/\bapply\(&app/.test(envBody));
    check("  a watchdog logs a main thread that stalls more than 2 s; the log is %LOCALAPPDATA%\\JOYA AI\\logs\\joya-desktop.log", /fn watchdog\(/.test(libRs) && /lag > 2000/.test(libRs) && /std::thread::spawn\(move \|\| watchdog\(/.test(libRs) && /"JOYA AI"\)\.join\("logs"\)/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "log.rs"), "utf8")) && /joya-desktop\.log/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "log.rs"), "utf8")));
    check("  Windows Hello: webauthn_ceremony is a command the site may call (it makes the window clickable, on top, focused)", /fn webauthn_ceremony\(/.test(libRs) && /"allow-webauthn-ceremony"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "remote.json"), "utf8")) && /"webauthn_ceremony"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "build.rs"), "utf8")) && /set_ignore_cursor_events\(false\)[\s\S]{0,400}set_focus\(\)/.test(fnBody("webauthn_ceremony")));
    const aIdx = (b, f) => b.indexOf(f + "?v=");
    check("the app's sign-in page loads joya-desktop-webauthn.js before every other script; a browser's does not load it", aIdx(la.body, "joya-desktop-webauthn.js") > 0 && aIdx(la.body, "joya-desktop-webauthn.js") < aIdx(la.body, "joya-desktop.js") && (aIdx(la.body, "passkey.js") < 0 || aIdx(la.body, "joya-desktop-webauthn.js") < aIdx(la.body, "passkey.js")) && !/joya-desktop-webauthn/.test(lw.body));
    check("  'Sign in in your browser' is a full-width button, not a small link", /class="btn w-full dk-browser-btn" id="dk-browser-signin"/.test(la.body) && /Sign in in your browser/.test(la.body));
    const fam = fs.readFileSync(path.join(ROOT, "public", "cc-family.js"), "utf8");
    const mdj = fs.readFileSync(path.join(ROOT, "public", "joya-desktop.js"), "utf8");
    check("session spheres: hover works in the app's small box (not taken for a phone), the card is in the hit regions, the sphere's region is the hover radius", /phone = W <= 720 && !document\.documentElement\.classList\.contains\("cc-desk"\)/.test(fam) && /"#cc-kcard\.on"/.test(mdj) && /q\.r \* 1\.25 \+ 8/.test(mdj) && /html\.cc-desk \.cc-kcard \{ display: block/.test(fs.readFileSync(path.join(ROOT, "public", "joya-desktop.css"), "utf8")));
    const A = await signIn("deskadmin", APP_UA);
    const maxAge = Number(((A.res.headers["set-cookie"] || []).join(";").match(/Max-Age=(\d+)/i) || [])[1] || (Date.parse(((A.res.headers["set-cookie"] || []).join(";").match(/Expires=([^;]+)/i) || [])[1]) - Date.now()) / 1000);
    check("signed in in the app: it lands on the desktop render mode", A.res.status === 302 && A.res.headers.location === "/joya-ai?shell=desktop", A.res.status + " " + A.res.headers.location);
    check("  and its session cookie lasts 14 days", maxAge > 13.9 * 86400 && maxAge <= 14 * 86400 + 5, maxAge);
    const W = await signIn("webadmin", WEB_UA);
    const wAge = Number(((W.res.headers["set-cookie"] || []).join(";").match(/Max-Age=(\d+)/i) || [])[1] || (Date.parse(((W.res.headers["set-cookie"] || []).join(";").match(/Expires=([^;]+)/i) || [])[1]) - Date.now()) / 1000);
    check("signed in in a browser: lands as always, 8 h", W.res.headers.location !== "/joya-ai?shell=desktop" && wAge > 7.9 * 3600 && wAge <= 8 * 3600 + 5, W.res.headers.location + " " + wAge);

    const pg = await s.req("GET", "/joya-ai?shell=desktop", { cookie: A.cookie, headers: { "User-Agent": APP_UA } });
    check("/joya-ai?shell=desktop: the Command Center in its desktop mode", pg.status === 200 && /class="cc-page cc-desk"/.test(pg.body) && /id="cc" data-shell="desktop"/.test(pg.body) && /id="dk-chatbtn"/.test(pg.body) && /<section class="dk-panel" id="dk-panel"[^>]*hidden>/.test(pg.body) && !/id="dk-chat"/.test(pg.body) && /id="dk-corehit"/.test(pg.body) && /id="dk-kb"/.test(pg.body));
    check("  the same scripts, plus the desktop ones; no Joya dock or page shell", /joya-ai\.js\?v=/.test(pg.body) && /joya-desktop\.js\?v=/.test(pg.body) && /joya-desktop-layout\.js\?v=/.test(pg.body) && /joya-desktop\.css\?v=/.test(pg.body) && !/joya-dock\.js/.test(pg.body) && !/joya-shell\.js/.test(pg.body) && !/id="joya-dock-root"/.test(pg.body));
    check("  no inline script or style anywhere", !/<script>(?!\s*<\/script>)/.test(pg.body) && !/\sstyle="/.test(pg.body) && !/\son[a-z]+="/.test(pg.body));
    const pw = await s.req("GET", "/joya-ai", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("/joya-ai without it is unchanged (the dock, the shell, no desktop parts)", pw.status === 200 && /id="joya-dock-root"/.test(pw.body) && /joya-shell\.js/.test(pw.body) && !/cc-desk/.test(pw.body) && !/dk-chat/.test(pw.body));

    // The live call's hold-to-talk turn mode is asked for by the desktop page only.
    const ma = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
    check("hold-to-talk: asked for only by the desktop page (o.ptt, set by pttPress on the desktop page)", /turn: o\.ptt \? "ptt" : undefined/.test(ma) && /if \(DESKTOP\) \{\s*window\.addEventListener\("pointerdown"/.test(ma) && /liveStart\(\{ ptt: true \}\)/.test(ma));

    section("the browser hand-off and the feed");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const port = 49731;
    const bad = await s.req("GET", "/desktop/link?c=short&p=80", { headers: { "User-Agent": WEB_UA } });
    check("a malformed link is refused", bad.status === 400);
    const out = await s.req("GET", `/desktop/link?c=${challenge}&p=${port}`, { headers: { "User-Agent": WEB_UA } });
    check("signed out: off to sign in first", out.status === 302 && out.headers.location === "/login");
    // Sign in in that same browser; it comes back to the link page.
    let bc = cookieOf(out);
    const lg = await s.req("GET", "/login", { cookie: bc, headers: { "User-Agent": WEB_UA } });
    bc = cookieOf(lg, bc);
    const lp = await s.req("POST", "/login", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lg.body), username: "linker", password: users.linker.pw, token: authenticator.generate(users.linker.secret) }).toString() });
    bc = cookieOf(lp, bc);
    check("  and after both factors, back to the link page", lp.status === 302 && lp.headers.location === `/desktop/link?c=${challenge}&p=${port}`, lp.headers.location);
    const lk = await s.req("GET", lp.headers.location, { cookie: bc, headers: { "User-Agent": WEB_UA } });
    check("the link page asks before linking, naming the account", lk.status === 200 && /Link the app/.test(lk.body) && /linker/.test(lk.body));
    const post = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lk.body), c: challenge, p: String(port) }).toString() });
    const to = (/data-to="([^"]+)"/.exec(post.body) || [])[1] || "";
    const code = (/code=([A-Za-z0-9_-]{43})/.exec(to) || [])[1];
    check("Link: the browser goes to the app's loopback with a one-time code (script + plain link)", post.status === 200 && new RegExp(`^http://127\\.0\\.0\\.1:${port}/joya-callback\\?code=[A-Za-z0-9_-]{43}$`).test(to) && /joya-desktop-link\.js/.test(post.body), to);
    const noCsrf = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ c: challenge, p: String(port) }).toString() });
    check("  Link without the CSRF token is refused", noCsrf.status === 403);
    const fromWeb = await s.req("GET", `/desktop/redeem?code=${code}&v=${verifier}`, { headers: { "User-Agent": WEB_UA } });
    check("redeeming is for the app only", fromWeb.status === 403);
    const wrong = await s.req("GET", `/desktop/redeem?code=${code}&v=${crypto.randomBytes(32).toString("base64url")}`, { headers: { "User-Agent": APP_UA } });
    check("  with the wrong secret: refused (and the code is spent)", wrong.status === 302 && wrong.headers.location === "/login?again=1");
    // A fresh code, redeemed properly.
    const post2 = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lk.body), c: challenge, p: String(port) }).toString() });
    const code2 = (/code=([A-Za-z0-9_-]{43})/.exec(post2.body) || [])[1];
    const red = await s.req("GET", `/desktop/redeem?code=${code2}&v=${verifier}`, { headers: { "User-Agent": APP_UA } });
    const rc = cookieOf(red);
    check("  with the right one: the app is signed in, on its render mode", red.status === 302 && red.headers.location === "/joya-ai?shell=desktop" && !!rc);
    const cc = await s.req("GET", "/joya-ai?shell=desktop", { cookie: rc, headers: { "User-Agent": APP_UA } });
    check("  and the session works", cc.status === 200 && /data-shell="desktop"/.test(cc.body));
    const again = await s.req("GET", `/desktop/redeem?code=${code2}&v=${verifier}`, { headers: { "User-Agent": APP_UA } });
    check("  a second redeem of the same code is refused", again.status === 302 && again.headers.location === "/login?again=1");
    const dev = await s.req("GET", "/devices", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("Devices still renders (desktop sessions are labelled there)", dev.status === 200);

    const feed0 = await s.req("GET", "/desktop/latest.json");
    check("the feed: 404 until a release is published", feed0.status === 404);
    const dir = path.join(s.data, "desktop");
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "files", "JOYA AI_0.1.0_x64-setup.exe"), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(dir, "files", "joya-desktop-codesign.cer"), Buffer.alloc(600, 2));
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ version: "0.1.0", notes: "First release.", pub_date: "2026-10-07T12:00:00Z", platforms: { "windows-x86_64": { signature: "dW50cnVzdGVkIGNvbW1lbnQ=", url: "https://joya.example.com/desktop/files/JOYA%20AI_0.1.0_x64-setup.exe" } } }));
    const feed = await s.req("GET", "/desktop/latest.json");
    check("  then the signed manifest, public and never cached long", feed.status === 200 && JSON.parse(feed.body).version === "0.1.0" && /no-cache/.test(feed.headers["cache-control"]));
    const file = await s.req("GET", "/desktop/files/JOYA%20AI_0.1.0_x64-setup.exe");
    check("  the installer is public (the updater has no cookie)", file.status === 200 && file.body.length === 2048 && /attachment/.test(file.headers["content-disposition"] || ""));
    const trav = await s.req("GET", "/desktop/files/..%2Flatest.json");
    check("  nothing else from there", trav.status === 404 && (await s.req("GET", "/desktop/files/x.js")).status === 404);
    const dl = await s.req("GET", "/desktop/", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("the download page: signed in only; the installer, its size, the certificate and how to trust it", dl.status === 200 && /JOYA AI_0\.1\.0_x64-setup\.exe/.test(dl.body) && /2 KB/.test(dl.body) && /joya-desktop-codesign\.cer/.test(dl.body) && /TrustedPublisher/.test(dl.body) && (await s.req("GET", "/desktop/")).status === 302);

    section("Settings > General > Desktop app");
    const sg = await s.req("GET", "/joya-ai/settings/general", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("the row is there with 14 days", sg.status === 200 && /id="g-desktop"/.test(sg.body) && /name="days"[^>]*value="14"/.test(sg.body));
    const sv = await s.req("POST", "/joya-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "21" }).toString() });
    const sb = await s.req("POST", "/joya-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "365" }).toString() });
    const la2 = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
    check("  saved (21), audited; 365 refused; the app's sign-in page says 21", sv.status === 303 && /msg=/.test(sv.headers.location) && /err=/.test(sb.headers.location) && /21 days/.test(la2.body));
    await s.req("POST", "/joya-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "14" }).toString() });

    if (chromium) {
      section("headless Chromium: the render mode on a transparent window");
      const browser = await chromium.launch();
      const errs = [];
      async function view(W_, H_, q, ua, cookieStr, dpr) {
        const ctx = await browser.newContext({ viewport: { width: W_, height: H_ }, deviceScaleFactor: dpr || 1, userAgent: ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        const cookies = String(cookieStr || "").split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port }));
        if (cookies.length) await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(q + ": " + e.message));
        page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(m.text())) errs.push(q + ": console " + m.text()); });
        page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errs.push(q + ": CSP " + m.text()); });
        await page.goto("http://127.0.0.1:" + s.port + q, { waitUntil: "load" });
        await page.waitForTimeout(900);
        return { ctx, page };
      }
      async function alphaAt(page, pts) {
        const buf = await page.screenshot({ omitBackground: true });
        // A PNG: read it back in the page (no image library here).
        return page.evaluate(async ({ b64, pts }) => {
          const img = new Image();
          img.src = "data:image/png;base64," + b64;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return pts.map((p) => g.getImageData(p[0], p[1], 1, 1).data[3]);
        }, { b64: buf.toString("base64"), pts });
      }
      const modes = [
        { name: "floating", W: 480, H: 860, q: "/joya-ai?shell=desktop&mode=floating" },
        { name: "floating-focus", W: 168, H: 168, q: "/joya-ai?shell=desktop&mode=floating&focus=1" },
        { name: "desktop", W: 1440, H: 852, q: "/joya-ai?shell=desktop&mode=desktop" },
        { name: "desktop-light-ink", W: 1440, H: 852, q: "/joya-ai?shell=desktop&mode=desktop&ink=dark" },
        { name: "peek", W: 1440, H: 852, q: "/joya-ai?shell=desktop&mode=peek" },
      ];
      for (const m of modes) {
        const { ctx, page } = await view(m.W, m.H, m.q, APP_UA, A.cookie);
        const info = await page.evaluate(() => {
          const L = window.JoyaDesktop && window.JoyaDesktop.layout();
          const r = window.JoyaDesktop && window.JoyaDesktop.regions();
          const comp = document.getElementById("cc-compose").getBoundingClientRect();
          const btn = document.getElementById("dk-chatbtn").getBoundingClientRect();
          const inPanel = !!document.querySelector("#dk-panel #cc-dock");
          const bg = getComputedStyle(document.body).backgroundColor;
          const top = getComputedStyle(document.querySelector(".topbar")).display;
          const core = window.__joyaCC && window.__joyaCC.orbit.layout;
          return { L, n: r ? r.length : 0, regs: r, inPanel, btn: { x: btn.x, y: btn.y, w: btn.width }, comp: { x: comp.x, y: comp.y, w: comp.width, h: comp.height }, bg, top, core: core && { cx: core.cx, cy: core.cy, R: core.R }, theme: document.documentElement.getAttribute("data-theme") };
        });
        const L = info.L;
        check(`${m.name}: laid out for its window; no top bar; the core where the layout says`, L && L.mode === m.name.split("-")[0] && info.top === "none" && info.core && Math.abs(info.core.cx - L.cx) < 1 && Math.abs(info.core.R - L.R) < 1, JSON.stringify({ L: L && { cx: L.cx, R: L.R }, core: info.core, top: info.top }));
        check(`  no composer or bubbles on show: the composer sits in the closed chat panel`, info.comp.w === 0 && info.inPanel, JSON.stringify(info.comp));
        if (!/focus/.test(m.name)) check(`  the chat button is where the layout puts it`, Math.abs(info.btn.x - (L.chatBtn.x - 17)) < 1.5 && Math.abs(info.btn.y - (L.chatBtn.y - 17)) < 1.5 && info.btn.w === 34, JSON.stringify(info.btn) + " " + JSON.stringify(L.chatBtn));
        else check(`  focus mode: no chat button`, info.btn.w === 0);
        if (m.name === "peek") check("  Peek while it shows: the whole window catches the mouse (a click on empty space hides it)", info.n === 1 && info.regs[0].w === m.W && info.regs[0].h === m.H);
        else check(`  the hit regions: the core${/focus/.test(m.name) ? "" : " and the chat button"}, not the whole window`, info.n >= (/focus/.test(m.name) ? 1 : 2) && !info.regs.some((r) => r.w === m.W && r.h === m.H) && info.regs.some((r) => r.r > 10) && (/focus/.test(m.name) || info.regs.some((r) => r.w === 34 && r.h === 34 && r.r === 17)), JSON.stringify(info.regs));
        check(`  ink: ${/light-ink/.test(m.name) ? "dark ink (light theme) for a light wallpaper" : "light ink (dark theme)"}`, info.theme === (/light-ink/.test(m.name) ? "light" : "dark"));
        if (m.name !== "peek") {
          // The far corners: nothing but the last breath of the core's glow (a few of 255), or nothing at all
          // where Floating clips the glow to its box's round corners.
          const a = await alphaAt(page, [[1, 1], [m.W - 2, 1], [1, m.H - 2], [m.W - 2, m.H - 2]]);
          check(`  transparent where nothing is drawn (corner alpha ${a.join("/")})`, a.every((x) => x <= 12) && (m.name !== "floating" || a[0] === 0));
        }
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, "desk-" + m.name + ".png"), omitBackground: true });
        }
        await ctx.close();
      }
      // Battery saver: the app's "hold still" sticks. A core started later (the Command Center's own start,
      // the page coming back from hidden) stays still; when the app lets go, it moves again.
      {
        const { ctx, page } = await view(1440, 852, "/joya-ai?shell=desktop&mode=desktop&still=1", APP_UA, A.cookie);
        const run = () => page.evaluate(() => { const c = window.__joyaCC.core; return { running: !!c.S.running, still: !!c.S.still }; });
        let r0 = await run();
        await page.evaluate(() => { window.__joyaCC.core.start(); document.dispatchEvent(new Event("visibilitychange")); });
        await page.waitForTimeout(200);
        const r1 = await run();
        check("hold still (?still=1, the app on battery): the core is not animating after the page settles", !r0.running && r0.still, JSON.stringify(r0));
        check("  and stays still when something starts it again (the core's start, the page visible again)", !r1.running && r1.still, JSON.stringify(r1));
        await page.evaluate(() => { const c = window.__joyaCC.core; c.S.still = false; c.S.running = false; });
        await page.waitForTimeout(2300);
        const r2 = await run();
        check("  a core that lost the still flag is caught by the guard within 2 s", !r2.running && r2.still, JSON.stringify(r2));
        await ctx.close();
        const v2 = await view(1440, 852, "/joya-ai?shell=desktop&mode=desktop", APP_UA, A.cookie);
        const r3 = await v2.page.evaluate(() => { const c = window.__joyaCC.core; return { running: !!c.S.running, still: !!c.S.still }; });
        check("  without it the core animates", r3.running && !r3.still, JSON.stringify(r3));
        await v2.ctx.close();
      }

      // The composer's talk hint never covers or squeezes the message box: Windows scaling 100 / 125 / 150 %
      // (the window is the work area in CSS px), the laptop the bug was seen on, a small screen where the panel
      // goes beside the core, and the fallback talk key.
      for (const [W_, H_, dpr, talk, nm] of [
        [1920, 1032, 1, "", "1920x1080 at 100 %"], [1536, 824, 1.25, "", "1920x1080 at 125 %"], [1280, 688, 1.5, "", "1920x1080 at 150 %"],
        [1389, 820, 1.5, "", "the laptop, 150 %"], [1389, 820, 1.5, "Ctrl+Alt+Space", "the laptop, 150 %, Ctrl+Alt+Space"], [1024, 552, 1.5, "Ctrl+Alt+Space", "1536x864 at 150 %, panel beside the core"],
      ]) {
        const { ctx, page } = await view(W_, H_, "/joya-ai?shell=desktop&mode=desktop" + (talk ? "&talk=" + encodeURIComponent(talk) : ""), APP_UA, A.cookie, dpr);
        await page.evaluate(() => { document.getElementById("cc-offline").hidden = true; });
        await page.click("#dk-chatbtn");
        await page.waitForTimeout(250);
        const probe = () => page.evaluate(() => {
          const inp = document.getElementById("cc-input"), kb = document.getElementById("dk-kb");
          const cs = getComputedStyle(inp), g = document.createElement("canvas").getContext("2d");
          g.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
          const need = g.measureText(inp.placeholder).width;
          const a = inp.getBoundingClientRect(), b = kb.getBoundingClientRect();
          const overlap = b.width > 0 && a.right > b.left + 0.5 && b.right > a.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5; // (a multi-line message sits above the controls)
          return { need: Math.round(need), room: inp.clientWidth, overlap, hint: window.JoyaDesktop.hint(), text: getComputedStyle(kb).display === "none" ? "" : kb.innerText.replace(/\s+/g, " ").trim(), panel: Math.round(document.getElementById("dk-panel").getBoundingClientRect().width) };
        });
        let v = await probe();
        const v0 = v;
        check(`composer hint, ${nm}: the whole placeholder fits, the hint never overlaps the box (${v.hint}${v.text ? ": " + v.text : ""}; panel ${v.panel}, box ${v.room} of ${v.need} px)`, v.room >= v.need && !v.overlap, JSON.stringify(v));
        await page.fill("#cc-input", "Summarise what the customs docs session did this morning and what is left");
        v = await probe();
        check(`  typed text: still no overlap`, !v.overlap, JSON.stringify(v));
        // The stop button showing while a turn runs (and the mic, where voice is on): the box narrows, the hint follows.
        await page.evaluate(() => { const b = document.getElementById("cc-stop"); b.hidden = false; b.style.display = "grid"; });
        await page.waitForTimeout(150);
        const vs = await probe();
        await page.evaluate(() => { const b = document.getElementById("cc-stop"); b.hidden = true; b.style.display = ""; });
        await page.waitForTimeout(150);
        const vb = await probe();
        check(`  the stop button appearing: still no overlap (${vs.hint}), and the hint is back as it was when it goes (${vb.hint})`, !vs.overlap && vb.hint === v.hint, JSON.stringify([vs, vb]));
        if (/beside/.test(nm)) check(`  (this one is narrow: with the field empty, the hint shortens to the key caps or goes)`, v0.hint !== "full", JSON.stringify(v0));
        if (/100 %/.test(nm)) check(`  (with room: the full hint)`, v.hint === "full" && /hold Ctrl ?Space to talk/.test(v.text), JSON.stringify(v));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-composer-" + W_ + "x" + H_ + (talk ? "-alt" : "") + ".png"), omitBackground: true });
        await ctx.close();
      }

      // The chat panel: closed by default; the button opens it with the recent conversation and the composer;
      // a reply while it is closed lights a dot; Esc and a click outside close it; its rect is a hit region only while open.
      for (const [W_, H_, q] of [[1440, 852, "mode=desktop"], [480, 860, "mode=floating"]]) {
        const { ctx, page } = await view(W_, H_, "/joya-ai?shell=desktop&" + q, APP_UA, A.cookie);
        const add = (rows) => page.evaluate((rows) => {
          const S = window.__joyaCC.S;
          document.getElementById("cc-offline").hidden = true; // the scratch copy has no supervisor
          rows.forEach(function (x) {
            S.turns.set(x[0], { id: x[0], source: "dashboard", text: x[1], blocks: [x[2]], partial: "", status: "done", created_at: new Date().toISOString() });
            S.turnOrder.push(x[0]);
          });
          document.dispatchEvent(new CustomEvent("joya-turns"));
        }, rows);
        const look = () => page.evaluate(() => {
          const p = document.getElementById("dk-panel"), b = document.getElementById("dk-chatbtn"), log = document.getElementById("dk-log");
          const pr = p.getBoundingClientRect();
          return { open: !p.hidden, unread: b.classList.contains("unread"), dot: getComputedStyle(b.querySelector(".dk-dot")).transform, msgs: [].map.call(log.querySelectorAll(".dk-msg"), (m) => m.textContent), scrolled: log.scrollHeight - log.scrollTop - log.clientHeight, panel: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, focus: document.activeElement && document.activeElement.id, regs: window.JoyaDesktop.regions(), comp: document.getElementById("cc-compose").getBoundingClientRect().width };
        });
        await add([[1, "What's waiting for me today?", "Two things: the invoice audit and the freight quotes."], [2, "Hire someone for the customs papers", "I hired Customs docs."]]);
        await page.waitForTimeout(4200); // the page's first seconds load the history: not "new"
        let v = await look();
        check(`chat (${q}): closed by default, no dot for the history the page loaded with`, !v.open && !v.unread && v.comp === 0, JSON.stringify(v));
        await add([[3, "And the label check?", "It is running."]]);
        await page.waitForTimeout(250);
        v = await look();
        check("  a reply while it is closed: only the dot on the button lights; nothing else shows", v.unread && !v.open && v.comp === 0, JSON.stringify(v));
        await page.click("#dk-chatbtn");
        await page.waitForTimeout(250);
        v = await look();
        const L = await page.evaluate(() => window.JoyaDesktop.layout());
        check("  the button opens the panel where the layout says: the conversation (newest last, scrolled to it), the composer in it, focused; the dot goes", v.open && !v.unread && v.msgs.length === 6 && /It is running/.test(v.msgs[5]) && v.scrolled < 2 && v.comp > 100 && v.focus === "cc-input" && Math.abs(v.panel.x - L.panel.x) < 1.5 && Math.abs(v.panel.y - L.panel.y) < 1.5 && Math.abs(v.panel.h - L.panel.h) < 1.5, JSON.stringify(v));
        check("  while open the panel is a hit region", v.regs.some((r) => Math.abs(r.x - Math.floor(L.panel.x)) <= 1 && Math.abs(r.w - L.panel.w) <= 2), JSON.stringify(v.regs));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-chat-open-" + W_ + ".png"), omitBackground: true });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        v = await look();
        check("  Esc closes it; its region goes", !v.open && !v.regs.some((r) => Math.abs(r.w - L.panel.w) <= 2 && r.h > 100), JSON.stringify(v));
        await page.click("#dk-chatbtn");
        await page.mouse.click(4, 4);
        await page.waitForTimeout(150);
        v = await look();
        check("  a click outside closes it; the button toggles it too", !v.open, JSON.stringify(v));
        await page.click("#dk-chatbtn");
        await page.click("#dk-chatbtn");
        v = await look();
        check("  (the button again: closed)", !v.open, JSON.stringify(v));
        await ctx.close();
      }
      // Everything a click can open must be usable in the app's window: the session's conversation (deep view),
      // its menu, the retire dialog, the sheet, a form, the palette. Each: inside the window, a hit region (or the
      // whole window), the click lands inside it, focus moves in, it scrolls / takes typing, Esc closes it -- and
      // only it (not the chat panel or a call).
      for (const [W_, H_, q, nm] of [[480, 860, "mode=floating", "Floating M"], [1920, 1032, "mode=desktop", "Desktop layer 1920"]]) {
        const { ctx, page } = await view(W_, H_, "/joya-ai?shell=desktop&" + q, APP_UA, A.cookie);
        await page.evaluate(() => {
          document.getElementById("cc-offline").hidden = true;
          const S = window.__joyaCC.S;
          S.sessions.push({ name: "Customs docs", session_id: "sx1", where: "Desktop · Claude Code", state: "waiting", hire: { slug: "customs-docs", kept: false, purpose: "the customs papers" } });
        });
        const audit = (sel) => page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false };
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          const regs = window.JoyaDesktop.regions();
          const cx = r.left + Math.min(r.width / 2, 120), cy = r.top + Math.min(r.height / 2, 60);
          const at = document.elementFromPoint(cx, cy);
          const covered = regs.some((g) => g.x <= r.left + 1 && g.y <= r.top + 1 && g.x + g.w >= r.right - 1 && g.y + g.h >= r.bottom - 1);
          return { found: true, visible: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0, inside: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, covered, hitsIt: !!(at && el.contains(at)), focusIn: el.contains(document.activeElement), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], cx, cy };
        }, sel);
        const ok = (a) => a.found && a.visible && a.inside && a.covered && a.hitsIt;
        const openPanel = async () => { await page.click("#dk-chatbtn"); await page.waitForTimeout(100); };
        const panelOpen = () => page.evaluate(() => !document.getElementById("dk-panel").hidden);

        // 1. The conversation of a session (deep view) -- the reported bug.
        await openPanel();
        await page.evaluate(() => window.__joyaCC.panels.openDeep("sx1"));
        await page.waitForTimeout(300);
        let a = await audit("#cc-ov");
        check(`${nm}: a session's conversation opens inside the window, the whole window catches the mouse, a click lands in it, focus is in it`, ok(a) && a.focusIn, JSON.stringify(a));
        await page.mouse.click(a.cx, a.cy);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(100);
        a = await audit("#cc-ov");
        check(`  a click and a scroll inside it keep it open`, a.found, JSON.stringify(a));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        check(`  Esc closes it -- and only it (the chat panel stays open)`, !(await page.evaluate(() => !!document.querySelector("#cc-overlay > *"))) && (await panelOpen()));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);

        // 2. A sphere's menu (right-click), and from it the retire dialog.
        const L = await page.evaluate(() => window.JoyaDesktop.layout());
        await page.evaluate((L) => window.__joyaCC.sessMenu("sx1", L.cx, L.cy), L);
        await page.waitForTimeout(100);
        a = await audit(".cc-smenu");
        check(`${nm}: a sphere's menu: inside the window, a hit region, clickable, focused`, ok(a) && a.focusIn, JSON.stringify(a));
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check(`  Esc closes the menu`, !(await page.evaluate(() => !!document.querySelector(".cc-smenu"))));
        await page.evaluate(() => window.__joyaCC.retire("sx1"));
        await page.waitForTimeout(100);
        a = await audit(".cc-sdlg");
        check(`${nm}: the retire / keep dialog: inside the window, the whole window catches the mouse, clickable, focused`, ok(a) && a.focusIn, JSON.stringify(a));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check(`  Esc closes it`, !(await page.evaluate(() => !!document.querySelector(".cc-sdlg-back"))));

        // 3. The sheet (a sphere's click opens Sessions there).
        await page.evaluate(() => window.__joyaCC.openSheet("sessions"));
        await page.waitForTimeout(450);
        a = await audit("#cc-sheet");
        check(`${nm}: the sheet: inside the window, the whole window catches the mouse, clickable`, ok(a), JSON.stringify(a));
        await page.mouse.wheel(0, 200);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        check(`  Esc closes it`, !(await page.evaluate(() => document.getElementById("cc-sheet").classList.contains("open"))));

        // 4. A form (a standing order) -- typing into it.
        await page.evaluate(() => window.__joyaCC.panels.openOrder && window.__joyaCC.panels.openOrder());
        await page.waitForTimeout(200);
        a = await audit("#cc-ov");
        const typed = await page.evaluate(() => { const i = document.querySelector("#cc-ov input:not([type=hidden]), #cc-ov textarea"); if (!i) return null; i.focus(); return true; });
        if (typed) await page.keyboard.type("check the backups");
        const val = await page.evaluate(() => { const i = document.querySelector("#cc-ov input:not([type=hidden]), #cc-ov textarea"); return i ? i.value : null; });
        check(`${nm}: a form: inside the window, clickable, takes typing`, ok(a) && /check the backups/.test(val || ""), JSON.stringify(a) + " " + val);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check(`  Esc closes it`, !(await page.evaluate(() => !!document.querySelector("#cc-overlay > *"))));

        // 5. The palette (Ctrl+K).
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(150);
        a = await audit("#cc-ov");
        await page.keyboard.type("sess");
        const pv = await page.evaluate(() => (document.getElementById("cc-pal-q") || {}).value);
        check(`${nm}: the palette: inside the window, clickable, takes typing`, ok(a) && pv === "sess", JSON.stringify(a) + " " + pv);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check(`  Esc closes it`, !(await page.evaluate(() => !!document.querySelector("#cc-overlay > *"))));
        if (SHOTS) {
          await page.evaluate(() => window.__joyaCC.panels.openDeep("sx1"));
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(SHOTS, "desk-deep-" + W_ + ".png"), omitBackground: true });
        }
        await ctx.close();
      }

      // The live-call button: next to the chat button, a hit region, starts / ends a call; joya://live does the same.
      require(path.join(ROOT, "lib", "db.js")).setSetting("voice_desk", "on", "test"); // the scratch database: voice on, so the button shows
      for (const [W_, H_, q] of [[480, 860, "mode=floating"], [384, 744, "mode=floating&size=S"], [1920, 1032, "mode=desktop"], [1440, 900, "mode=peek"]]) {
        const { ctx, page } = await view(W_, H_, "/joya-ai?shell=desktop&" + q, APP_UA, A.cookie);
        const v = await page.evaluate(() => {
          const L = window.JoyaDesktop.layout(), b = document.getElementById("dk-livebtn"), c = document.getElementById("dk-chatbtn"), p = document.getElementById("cc-cap-state");
          const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect(), pr = p.getBoundingClientRect();
          const apart = (x, y) => x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top;
          return { shown: getComputedStyle(b).display !== "none", w: br.width, clearOfChat: apart(br, cr), clearOfPill: apart(br, pr), inWin: br.right <= innerWidth && br.bottom <= innerHeight && cr.right <= innerWidth, region: window.JoyaDesktop.regions().some((g) => (g.w === 34 && Math.abs(g.x - Math.floor(br.left)) <= 1 && Math.abs(g.y - Math.floor(br.top)) <= 1) || (g.x === 0 && g.y === 0 && g.w === innerWidth && g.h === innerHeight)), /* (Peek open: the whole window) */ title: b.title };
        });
        check(`live button (${q}): shown, 34 px, clear of the chat button and the pill, in the window, a hit region; tooltip names the action`, v.shown && v.w === 34 && v.clearOfChat && v.clearOfPill && v.inWin && v.region && /Start a live conversation/.test(v.title), JSON.stringify(v));
        await ctx.close();
      }
      {
        // The page side of the button and the app's key (Tauri stood in for): start, then end.
        const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        await ctx.addInitScript(() => {
          const L = {};
          window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
          window.__TAURI__ = { core: { invoke: (cmd) => Promise.resolve(cmd === "get_state" ? { liveKey: "Ctrl+Alt+L", talkKey: "Ctrl+Space" } : null) }, event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } } };
        });
        const page = await ctx.newPage();
        await page.goto("http://127.0.0.1:" + s.port + "/joya-ai?shell=desktop&mode=floating", { waitUntil: "load" });
        await page.waitForTimeout(600);
        // A fake live layer: what the button and the key ask of the call.
        await page.evaluate(() => {
          const calls = (window.__liveCalls = []);
          let mode = "";
          window.__joyaLive = { ok: () => true, active: () => !!mode, mode: () => mode, toggle: () => { calls.push("start"); mode = "live"; return true; }, end: (why) => { calls.push("end:" + why); mode = ""; return true; }, ptt: () => {}, level: () => 0 };
        });
        const title0 = await page.evaluate(() => document.getElementById("dk-livebtn").title);
        await page.click("#dk-livebtn");
        await page.waitForTimeout(300);
        const on = await page.evaluate(() => ({ cls: document.getElementById("dk-livebtn").className, label: document.getElementById("dk-livebtn").getAttribute("aria-label") }));
        await page.click("#dk-livebtn");
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__emit("joya://live", { at: Date.now() }));
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__emit("joya://live", { at: Date.now() }));
        await page.waitForTimeout(300);
        const calls = await page.evaluate(() => window.__liveCalls);
        check("the live button: 'Start a live conversation (Ctrl+Alt+L)'; a click starts a call, the button turns red 'End conversation', a click ends it", title0 === "Start a live conversation (Ctrl+Alt+L)" && /\bon\b/.test(on.cls) && on.label === "End conversation" && calls[0] === "start" && calls[1] === "end:button", JSON.stringify({ title0, on, calls }));
        check("  the app's live key (joya://live) does the same: start, then end", calls[2] === "start" && calls[3] === "end:button", JSON.stringify(calls));
        // A warm hold-to-talk call: the button starts a live call in its place.
        await page.evaluate(() => { const m = window.__joyaLive; let mode = "ptt"; m.mode = () => mode; m.active = () => !!mode; m.end = (w) => { window.__liveCalls.push("end:" + w); mode = ""; return true; }; m.toggle = () => { window.__liveCalls.push("start"); mode = "live"; return true; }; });
        await page.click("#dk-livebtn");
        await page.waitForTimeout(800);
        const c2 = await page.evaluate(() => window.__liveCalls.slice(4));
        check("  over a warm hold-to-talk call: that call ends, a live one starts", JSON.stringify(c2) === JSON.stringify(["end:button", "start"]), JSON.stringify(c2));
        await ctx.close();
      }
      // Real blur: the page reports its settled glass surfaces, takes the lighter tint only once reported,
      // drops them at once when they go, and reports nothing while the app draws no blur.
      for (const glassOn of [true, false]) {
        const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        await ctx.addInitScript((on) => {
          const L = {};
          window.__blur = [];
          window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
          window.__TAURI__ = { core: { invoke: (cmd, args) => {
            if (cmd === "set_blur_rects") window.__blur.push(JSON.parse(JSON.stringify(args.rects)));
            return Promise.resolve(cmd === "get_state" ? { mode: "floating", size: "M", liveKey: "Ctrl+Alt+L", talkKey: "Ctrl+Space", glass: on } : null);
          } }, event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } } };
        }, glassOn);
        const page = await ctx.newPage();
        const perrs = [];
        page.on("pageerror", (e) => perrs.push(e.message));
        await page.goto("http://127.0.0.1:" + s.port + "/joya-ai?shell=desktop", { waitUntil: "load" });
        await page.waitForTimeout(700);
        await page.click("#dk-chatbtn");
        await page.waitForTimeout(700);
        const open = await page.evaluate(() => {
          const p = document.getElementById("dk-panel"), r = p.getBoundingClientRect(), last = window.__blur[window.__blur.length - 1] || [];
          const inside = (g) => window.JoyaDesktop.regions().some((h) => g.x >= h.x - 1 && g.y >= h.y - 1 && g.x + g.w <= h.x + h.w + 1 && g.y + g.h <= h.y + h.h + 1);
          return { acrylic: document.documentElement.classList.contains("dk-acrylic"), mark: p.getAttribute("data-dk-glass"), bg: getComputedStyle(p).backgroundColor, panel: last.some((g) => Math.abs(g.x - r.left) <= 0.5 && Math.abs(g.y - r.top) <= 0.5 && Math.abs(g.w - r.width) <= 0.5 && g.r > 10), pill: last.some((g) => g.h < 40 && g.r >= g.h / 2 - 1), all: last.every(inside), n: last.length, sends: window.__blur.length };
        });
        await page.click("#dk-panel-x");
        await page.waitForTimeout(150);
        const closed = await page.evaluate(() => { const last = window.__blur[window.__blur.length - 1] || []; const r = document.getElementById("dk-chatbtn").getBoundingClientRect(); return { mark: document.getElementById("dk-panel").getAttribute("data-dk-glass"), panelGone: !last.some((g) => g.h > 200), sends: window.__blur.length }; });
        await page.waitForTimeout(600);
        const idle = await page.evaluate(() => window.__blur.length);
        if (glassOn) {
          check("real blur on: the open chat panel and the state pill are reported (the panel's own rectangle and radius), each inside a hit region; the panel takes the glass tint", open.acrylic && open.mark === "card" && open.panel && open.pill && open.all && /rgba\(16, 18, 40, 0\.7\)/.test(open.bg), JSON.stringify(open));
          check("  closing the panel drops its blur at once (nothing in the next report) and its glass tint", closed.mark === null && closed.panelGone);
          check("  nothing is sent while nothing changes (no per-frame reports)", idle === closed.sends, idle + " vs " + closed.sends);
        } else {
          check("real blur off (old Windows, setting off): nothing is reported, the panel keeps its solid tint", !open.acrylic && open.mark === null && open.n === 0 && /0\.92/.test(open.bg), JSON.stringify(open));
        }
        check("  no page errors", perrs.length === 0, perrs.join(" / "));
        await ctx.close();
      }
      // The app's Settings window (desktop/dist/settings.html), with the app's commands stood in for.
      {
        const D = path.join(ROOT, "..", "desktop");
        const ctx = await browser.newContext({ viewport: { width: 560, height: 760 } });
        await ctx.addInitScript(() => {
          const settings = { mode: "floating", focus: false, monitor: "", hotkeys: { talk: "Ctrl+Space", show: "Ctrl+Alt+M", focus: "Ctrl+Alt+F", live: "Ctrl+Alt+L" }, per_monitor: {}, do_not_disturb: false, battery_saver: true, autostart: true, check_updates: true, experimental_behind_icons: false };
          window.__inv = [];
          window.__TAURI__ = { core: { invoke: (cmd, args) => {
            window.__inv.push({ cmd, args: args ? JSON.parse(JSON.stringify(args)) : null });
            if (cmd === "settings_get") return Promise.resolve({ settings: JSON.parse(JSON.stringify(window.__saved || settings)), version: "0.1.4", talkKey: "Ctrl+Space", talkFallback: false, liveKey: "Ctrl+Alt+L", liveFallback: false, monitors: [], monitorKey: "A", update: null, blurNote: window.__blurNote || null });
            if (cmd === "settings_set") { window.__saved = args.value; return Promise.resolve(null); }
            return Promise.resolve(null);
          } } };
        });
        const page = await ctx.newPage();
        const perrs = [];
        page.on("pageerror", (e) => perrs.push(e.message));
        await page.goto("file://" + path.join(D, "dist", "settings.html"));
        await page.waitForTimeout(300);
        const inv = () => page.evaluate(() => window.__inv.map((x) => x.cmd));
        await page.click("#cancel");
        await page.waitForTimeout(100);
        check("Settings: Close with nothing changed asks the app to close the window (settings_close), never window.close()", (await inv()).includes("settings_close") && !/window\.close\(/.test(fs.readFileSync(path.join(D, "dist", "settings.js"), "utf8")), JSON.stringify(await inv()));
        await page.evaluate(() => (window.__inv.length = 0));
        await page.click("#dnd");
        await page.click("#cancel");
        await page.waitForTimeout(100);
        const msg = await page.evaluate(() => document.getElementById("err").textContent);
        check("  with unsaved changes the first Close says so and does not close", !(await inv()).includes("settings_close") && /unsaved changes/.test(msg), msg);
        await page.click("#cancel");
        await page.waitForTimeout(100);
        check("  Close again discards them and closes", (await inv()).includes("settings_close"));
        await page.evaluate(() => (window.__inv.length = 0));
        // A hotkey box records a key; Esc there stops recording and does not close.
        await page.click("#hk-live");
        await page.keyboard.press("Control+Alt+KeyK");
        await page.click("#hk-talk");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check("  a hotkey box records Ctrl+Alt+K for the live key; Esc in a hotkey box does not close the window", (await page.evaluate(() => document.getElementById("hk-live").value)) === "Ctrl+Alt+K" && !(await inv()).includes("settings_close"));
        await page.click("#save");
        await page.waitForTimeout(150);
        const saved = await page.evaluate(() => window.__inv.find((x) => x.cmd === "settings_set"));
        check("  Save sends the settings with the new live key (settings_set), then reads them back", saved && saved.args.value.hotkeys.live === "Ctrl+Alt+K" && (await inv()).slice(-1)[0] === "settings_get", JSON.stringify(saved && saved.args.value.hotkeys));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        check("  Esc after saving closes the window", (await inv()).includes("settings_close"));
        await page.evaluate(() => (window.__inv.length = 0));
        await page.click("#upd");
        check("  Check for updates asks the app (settings_check_update)", (await inv()).includes("settings_check_update"));
        const blur0 = await page.evaluate(() => document.getElementById("blur").checked);
        await page.evaluate(() => { window.__blurNote = "Windows' transparency effects are off (Settings ▸ Personalization ▸ Colours): the tinted look is used."; });
        await page.click("#blur");
        await page.click("#save");
        await page.waitForTimeout(150);
        const sb = await page.evaluate(() => ({ v: (window.__inv.filter((x) => x.cmd === "settings_set").pop() || {}).args, note: document.getElementById("blur-note").textContent, warn: document.getElementById("blur-note").classList.contains("warn") }));
        check("  'Real blur behind cards': on by default (a file without it), unticked and saved as real_blur false; the app's reason it cannot blur shows under it", blur0 === true && sb.v && sb.v.value.real_blur === false && /transparency effects are off/.test(sb.note) && sb.warn, JSON.stringify(sb));
        check("  no page errors", perrs.length === 0, perrs.join(" / "));
        await ctx.close();
        const local = JSON.parse(fs.readFileSync(path.join(D, "src-tauri", "capabilities", "local.json"), "utf8"));
        const remote = fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8");
        const lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
        check("Settings' commands are allowed to the Settings window only (local pages), never to the site; settings_close destroys the window after answering, and the next open builds a fresh one", local.windows.includes("settings") && ["allow-settings-get", "allow-settings-set", "allow-settings-close", "allow-settings-check-update"].every((p) => local.permissions.includes(p)) && !/allow-settings/.test(remote) && /"settings_close"/.test(fs.readFileSync(path.join(D, "src-tauri", "build.rs"), "utf8")) && /fn settings_close\([\s\S]{0,600}on_main\([\s\S]{0,200}\.destroy\(\)/.test(lib) && /fn open_settings\([\s\S]{0,300}get_webview_window\(SETTINGS_WIN\)[\s\S]{0,300}WebviewWindowBuilder::new\(app, SETTINGS_WIN/.test(lib));
        check("the live-call key: registered with a fallback and a toast (like the talk key), shown first if hidden or Peek is closed, sent to the page as joya://live", /settings::FALLBACK_LIVE/.test(lib) && /"joya:\/\/live"/.test(lib) && /Press Ctrl\+Alt\+Shift\+L for a live conversation/.test(lib) && /live_key: a\.live_key\.clone\(\)/.test(lib));
      }
      // Focus mode: no button, no panel (even if asked to open).
      {
        const { ctx, page } = await view(168, 168, "/joya-ai?shell=desktop&mode=floating&focus=1", APP_UA, A.cookie);
        const v = await page.evaluate(() => ({ btn: getComputedStyle(document.getElementById("dk-chatbtn")).display, live: getComputedStyle(document.getElementById("dk-livebtn")).display, panel: document.getElementById("dk-panel").hidden }));
        check("focus mode: the chat and live buttons are hidden and the panel stays closed", v.btn === "none" && v.live === "none" && v.panel, JSON.stringify(v));
        await ctx.close();
      }
      // Listening: on the state pill only, with a small meter.
      {
        const { ctx, page } = await view(480, 860, "/joya-ai?shell=desktop&mode=floating", APP_UA, A.cookie);
        const v = await page.evaluate(() => {
          const c = document.getElementById("cc-cap-state");
          c.setAttribute("data-s", "listening");
          const m = c.querySelector(".dk-meter");
          return { meter: !!m && getComputedStyle(m).display, bars: m ? m.children.length : 0, bar: document.getElementById("cc-voicebar").getBoundingClientRect().width };
        });
        check("listening shows on the pill (a 4-bar meter), never as a bar on the desktop", /flex/.test(v.meter) && v.bars === 4 && v.bar === 0, JSON.stringify(v));
        await ctx.close();
      }
      // The sign-in card as the app shows it, and the browser pages.
      {
        const { ctx, page } = await view(480, 860, "/login?mode=floating", APP_UA, "");
        const r = await page.evaluate(() => { const c = document.querySelector(".auth-wrap .card").getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height, regs: window.JoyaDesktop.regions(), hand: !!document.getElementById("dk-browser-signin") }; });
        check("the app's sign-in card floats in the window, and only it catches the mouse", r.w > 300 && r.y + r.h <= 860 && r.regs.length >= 1 && r.regs.every((g) => g.w < 480 || g.h < 860) && r.hand, JSON.stringify(r));
        const a = await alphaAt(page, [[2, 2], [470, 10]]);
        check("  transparent round it (the grey core's glow fades out)", a.every((x) => x <= 12), a.join("/"));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-signin.png"), omitBackground: true });
        await ctx.close();
      }
      // Windows Hello inside the app: the page tells the app when a passkey ceremony starts and ends,
      // and a failed one lights up the browser sign-in. (Tauri's IPC is stood in for; the ceremony fails at once: wrong rpId.)
      {
        const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addInitScript(() => {
          window.__calls = [];
          window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push(cmd === "webauthn_ceremony" ? "ceremony:" + args.on : cmd); return Promise.resolve(null); } }, event: { listen: () => Promise.resolve(() => {}) } };
        });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push("webauthn: " + e.message));
        await page.goto("http://127.0.0.1:" + s.port + "/login?mode=floating", { waitUntil: "load" });
        const r = await page.evaluate(async () => {
          let err = null;
          try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "example.com", timeout: 2000, userVerification: "preferred" } }); } catch (e) { err = e.name; }
          await new Promise((ok) => setTimeout(ok, 50));
          const b = document.getElementById("dk-browser-signin");
          return { err, calls: window.__calls.filter((c) => /^ceremony/.test(c)), urge: b && b.classList.contains("dk-urge"), note: (document.getElementById("dk-browser-note") || {}).textContent || "", h: b && b.getBoundingClientRect().height, w: b && b.getBoundingClientRect().width, card: document.querySelector(".auth-wrap .card button[type=submit]").getBoundingClientRect().width };
        });
        check("a passkey ceremony in the app: the app is told it starts and ends; when it fails the browser sign-in is lit up", !!r.err && JSON.stringify(r.calls) === JSON.stringify(["ceremony:true", "ceremony:false"]) && r.urge && /did not finish inside the app/.test(r.note), JSON.stringify(r));
        check("  the browser sign-in button is big: at least 40 px tall, as wide as the Sign in button", r.h >= 40 && Math.abs(r.w - r.card) < 2, JSON.stringify(r));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-signin-hello-failed.png"), omitBackground: true });
        await ctx.close();
      }
      // The start path, as the app's start card meets it: a page of another origin (the app's is
      // http://tauri.localhost; here a second server on another port, same address space).
      {
        const http = require("http");
        const other = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<!doctype html><title>start</title>"); });
        await new Promise((r) => other.listen(0, "127.0.0.1", r));
        const oport = other.address().port;
        const SITE = "http://127.0.0.1:" + s.port;
        const ctx = await browser.newContext({ userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        const page = await ctx.newPage();
        await page.goto("http://localhost:" + oport + "/");
        const probe = await page.evaluate(async (site) => {
          const one = (u) => fetch(u, { mode: "no-cors", cache: "no-store" }).then(() => "ok", (e) => "refused: " + e.message);
          return { ping: await one(site + "/desktop/ping"), manifest: await one(site + "/manifest.webmanifest"), login: await one(site + "/login") };
        }, SITE);
        check("cross-origin probe from the start card's origin: /desktop/ping and /manifest.webmanifest answer; an ordinary page is refused by CORP (the 0.1.0 'Offline' trap)", probe.ping === "ok" && probe.manifest === "ok" && /refused/.test(probe.login), JSON.stringify(probe));
        // The session cookie is SameSite=Strict: a navigation the start page makes is cross-site and goes without it.
        const jar = String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Strict" }));
        await ctx.addCookies(jar);
        await Promise.all([page.waitForURL(/127\.0\.0\.1/, { waitUntil: "load" }), page.evaluate((u) => { location.href = u; }, SITE + "/joya-ai?shell=desktop")]);
        const viaPage = page.url();
        // ...and the sign-in page it lands on starts a new session, whose cookie replaces the signed-in one.
        const anon = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
        check("  (and its second half: that sign-in page sets a new joya.sid, which would replace the still-valid one)", /^joya\.sid=/.test((anon.headers["set-cookie"] || [""])[0]) && /SameSite=Strict/i.test((anon.headers["set-cookie"] || [""])[0]));
        await ctx.addCookies(jar);
        await page.goto(SITE + "/joya-ai?shell=desktop"); // what the app's go_site does: a navigation with no initiating site
        const viaApp = page.url();
        const shell = await page.evaluate(() => !!document.querySelector('#cc[data-shell="desktop"]'));
        check("SameSite=Strict: the start page's own navigation lands on sign-in although signed in; the app's navigation (go_site) opens the Command Center", /\/login/.test(viaPage) && /\/joya-ai\?shell=desktop$/.test(viaApp) && shell, viaPage + " | " + viaApp);
        await ctx.close();
        other.close();
      }
      // Signed out in the app: the sign-in page renders visibly, with its assets, and only its card catches the mouse.
      {
        const { ctx, page } = await view(480, 860, "/joya-ai?shell=desktop", APP_UA, "");
        const r = await page.evaluate(() => {
          const c = document.querySelector(".auth-wrap .card");
          const b = c && c.getBoundingClientRect();
          return { url: location.pathname, css: [].some.call(document.styleSheets, (x) => /joya-desktop\.css/.test(x.href || "")), core: !!window.JoyaCoreD, card: b && { y: b.y, h: b.height, vis: getComputedStyle(c).visibility, op: getComputedStyle(c).opacity }, hand: !!document.getElementById("dk-browser-signin"), regs: window.JoyaDesktop && window.JoyaDesktop.regions() };
        });
        check("signed out, /joya-ai?shell=desktop -> the app's sign-in page: its stylesheet and scripts load, the card is visible inside the window", r.url === "/login" && r.css && r.core && r.card && r.card.y >= 0 && r.card.y + r.card.h <= 860 && r.card.vis === "visible" && r.card.op === "1" && r.regs && r.regs.length >= 1, JSON.stringify(r));
        await ctx.close();
      }
      for (const [w, h, theme] of [[1440, 900, "light"], [390, 844, "light"], [1440, 900, "dark"], [390, 844, "dark"]]) {
        const { ctx, page } = await view(w, h, "/desktop/", WEB_UA, W.cookie);
        await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        check(`the download page at ${w} (${theme}): no sideways scroll`, ov);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `desktop-download-${w}-${theme}.png`), fullPage: true });
        await ctx.close();
      }
      check("zero page errors and CSP violations across all of it", errs.length === 0, errs.join("\n"));
      await browser.close();
    }
  } catch (e) {
    check("the server run completed", false, e.stack + "\n" + s.out().slice(-2000));
  } finally {
    s.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
