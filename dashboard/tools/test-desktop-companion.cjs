#!/usr/bin/env node
"use strict";
/**
 * Companion mode in the JOYA AI desktop app, simplified (2026-10-21; the user: "I just want the core showing at
 * the centre top of the screen, on top of all apps, always"): the page side, public/joya-desktop-companion.js,
 * and its seams with joya-desktop.js and the app.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-companion.cjs
 *
 * Pure parts first (the numbers against companion.rs, the layout, the hit region); then the app's sources (the
 * command, the tray switch, no blur, the loop: top centre, fade across monitors, on top, full-screen duck, and
 * none of 0.1.12's perching / walking / session bots left); Settings; then headless Chromium on a scratch copy of
 * the server with a stand-in for the app's bridge: the bot alone at the top of its small window, only it catching
 * the mouse, the "Camera on" pill under it, its states, the fades, a click opening its Peek, holding still --
 * with no page errors or CSP violations.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, "..", "desktop");
const C = require(path.join(ROOT, "public", "joya-desktop-companion.js"));
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.13";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  section("the numbers: the page and the app (companion.rs) agree");
  const rs = fs.readFileSync(path.join(D, "src-tauri", "src", "companion.rs"), "utf8");
  {
    const num = (k) => { const m = new RegExp("pub const " + k + ": (?:f64|u64) = ([0-9.]+);").exec(rs); return m ? Number(m[1]) : NaN; };
    for (const k of ["WIN_W", "WIN_H", "BODY_R", "BODY_CY", "FADE_MS"]) check("  " + k + " = " + C[k] + " on both sides", num(k) === C[k], num(k));
    check("  a small window (176 x 160 logical px), the bot about 104 px across (96-128)", C.WIN_W * C.WIN_H < 30000 && 2 * C.BODY_R >= 96 && 2 * C.BODY_R <= 128);
    check("  the hit circle matches the drawn core (head + backplate show about 0.75 of its radius) and sits inside the window, a little under its top", Math.abs(0.75 * C.HEAD_R - C.BODY_R) <= 4 && C.BODY_CY - C.BODY_R >= 6 && C.BODY_CY + C.BODY_R < C.WIN_H && C.BODY_R <= C.WIN_W / 2);
  }

  section("layout and hit region");
  {
    const L = C.layout(176, 160);
    check("the bot centred at the top; the hint under it", L.cx === 88 && L.cy === C.BODY_CY && L.R === C.HEAD_R && L.hintY > L.cy + C.BODY_R);
    const r = C.regions(L, false);
    check("  one hit region: the bot's circle", r.length === 1 && r[0].w === 2 * C.BODY_R && r[0].h === 2 * C.BODY_R && r[0].r === C.BODY_R && r[0].x + r[0].w / 2 === 88 && r[0].y === C.BODY_CY - C.BODY_R, JSON.stringify(r));
    check("  faded out (moving to another monitor, ducking out): none -- clicks pass through", C.regions(L, true).length === 0);
    const old = C.layout(264, 140), ro = C.regions(old, false);
    check("  in 0.1.12's 264 x 140 window (the page reaches an app not yet updated): still centred at the top, inside the window", old.cx === 132 && ro.length === 1 && ro[0].y >= 0 && ro[0].y + ro[0].h <= 140, JSON.stringify(ro));
    check("  a tiny window: clipped, never outside", C.regions(C.layout(60, 60), false).every((q) => q.x >= 0 && q.y >= 0 && q.x + q.w <= 60 && q.y + q.h <= 60));
    check("  only the pure parts and mount are exported (no 0.1.12 gather / motion / limbs / idlePick)", ["gather", "motion", "limbs", "kidsAt", "idlePick"].every((k) => !(k in C)) && typeof C.mount === "function");
  }

  section("the app's side (sources)");
  {
    const lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
    const host = fs.readFileSync(path.join(D, "src-tauri", "src", "companion_host.rs"), "utf8");
    const plat = fs.readFileSync(path.join(D, "src-tauri", "src", "platform.rs"), "utf8");
    const remote = fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8");
    const build = fs.readFileSync(path.join(D, "src-tauri", "build.rs"), "utf8");
    check("the page may say one thing (companion: open), granted to the site; anything else is ignored", /"allow-companion"/.test(remote) && /"companion"/.test(build) && /fn companion\(app: AppHandle, kind: String/.test(lib) && /if kind != "open" \{\s*return;/.test(host));
    check("no blur in Companion mode", /a\.settings\.mode != Mode::Companion && acrylic::live\(\)/.test(lib));
    check("the tray switch: Companion on, and off back to the mode it came from", /"mode:companion"/.test(lib) && /before_companion/.test(lib) && /JOYA AI at the top of the screen/.test(lib));
    check("the loop runs on its own thread", /std::thread::spawn\(move \|\| companion_host::run\(/.test(lib));
    check("  top centre of the active monitor (pick_monitor, window_rect); a fade across (Switch: fade-out, then fade-in)", /cp::pick_monitor\(/.test(host) && /cp::window_rect\(/.test(host) && /SwitchOut::FadeOut\(_\) => emit\(&app, "fade-out"\)/.test(host) && /emit\(&app, "fade-in"\)/.test(host));
    check("  on top of every app: always-on-top, and put on top again (HWND_TOPMOST, no activation, asynchronous) when the window in front changes and every few seconds", /set_always_on_top\(true\)/.test(host) && /platform::to_top\(raw\)/.test(host) && /HWND_TOPMOST/.test(plat) && /SWP_NOACTIVATE/.test(plat) && /SWP_ASYNCWINDOWPOS/.test(plat) && /Mode::Floating \| Mode::Peek \| Mode::Companion => true/.test(lib));
    check("  full screen on its monitor ducks it out (policy::fullscreen_hold), and it comes back (pop); a meeting no longer hides it", /policy::fullscreen_hold\(/.test(host) && /emit\(app, "duck"\)/.test(host) && /emit\(app, "pop"\)/.test(host) && !/cap_use/.test(host));
    check("  it reads window geometry only: no screen capture, no input injection", !/BitBlt|PrintWindow|GetDIBits|SendInput|keybd_event|mouse_event|Graphics\.Capture/.test(host + rs));
    check("0.1.12's perching, walking, stepping aside and session bots are gone (companion.rs, companion_host.rs, platform.rs)", !/Taskbar|Perch|Dodge|LegKind|walk_fps|taskbar_perch|fn plan\(|look_at|session_bots/.test(rs + host) && !/fn taskbars|fn move_window/.test(plat));
    check("  and its scripted preview is retired", !fs.existsSync(path.join(D, "core-tests", "examples", "companion_sim.rs")) && !fs.existsSync(path.join(__dirname, "shots-desk-companion.cjs")));
    const set = fs.readFileSync(path.join(D, "src-tauri", "src", "settings.rs"), "utf8");
    check("settings: companion keeps only stay_on_monitor (0.1.12's perch, session bots and side are dropped on the next save)", /pub struct Companion \{\s*pub stay_on_monitor: bool,\s*\}/.test(set) && !/PerchPref|session_bots: bool|pub side: f64/.test(set));
    const sh = fs.readFileSync(path.join(D, "dist", "settings.html"), "utf8"), sj = fs.readFileSync(path.join(D, "dist", "settings.js"), "utf8");
    check("Settings window: Mode ▸ Companion; only \"Stay on this monitor\" (off by default); no perch, no session bots", /data-v="companion">Companion</.test(sh) && /id="comp-stay"/.test(sh) && !/data-k="perch"|id="comp-bots"/.test(sh) && /S\.companion = \{ stay_on_monitor: \$\("comp-stay"\)\.checked \}/.test(sj) && !/perch|session_bots/.test(sj));
    const views = fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8");
    check("the page loads the companion before joya-desktop.js (the desktop render mode only)", /"joya-desktop-companion\.js", "joya-ai\.js"[^\]]*"joya-desktop\.js"\]/.test(views));
    const md = fs.readFileSync(path.join(ROOT, "public", "joya-desktop.js"), "utf8");
    check("joya-desktop.js: the bot's region (+ the pill, not while faded) only while it is out; Esc / empty space close its Peek; the Command Center's core rests", /if \(compOut\(\) && comp\) return withCam\(comp\.regions\(\)/.test(md) && /dk-comp-faded/.test(md) && /if \(peekish\(\)\) invoke\("hide_peek"\)/.test(md) && /st\.hidden \|\| compOut\(\)/.test(md));
  }

  section("in the browser (a scratch server, a stand-in for the app's bridge)");
  {
    let chromium;
    try { ({ chromium } = require(process.env.PLAYWRIGHT || "playwright")); } catch (e) { chromium = null; }
    if (!chromium) { check("playwright is available (set PLAYWRIGHT)", false); }
    else {
      const s = await scratch.startScratch({});
      let browser = null;
      try {
        await s.makeUser("comp", "administrator");
        const { cookie } = await s.signIn("comp");
        browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
        async function open(host, W, H) {
          const ctx = await browser.newContext({ viewport: { width: W || 176, height: H || 160 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
          await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
          const page = await ctx.newPage();
          const errs = [];
          page.on("pageerror", (e) => errs.push(e.message));
          page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
          await page.addInitScript((h) => {
            window.__csp = [];
            document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
            window.__calls = [];
            const L = (window.__listeners = {});
            window.__TAURI__ = {
              core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? h : null); } },
              event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } },
            };
            window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
            setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 50);
          }, host);
          await page.goto("http://127.0.0.1:" + s.port + "/joya-ai?shell=desktop", { waitUntil: "load" });
          await page.waitForTimeout(900);
          return { ctx, page, errs };
        }
        const HOST = { mode: "companion", peekOpen: false, still: false, companion: { stayOnMonitor: false, ducked: false } };
        const { ctx, page, errs } = await open(HOST);
        const lastRegs = () => page.evaluate(() => { const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions); return regs[regs.length - 1] || null; });
        const st = await page.evaluate(() => {
          const cc = document.getElementById("cc"), k = window.JoyaDesktop.companion().debug.core();
          return { mode: document.documentElement.getAttribute("data-dk-mode"), out: document.documentElement.classList.contains("dk-comp-out"), comp: !document.getElementById("dk-comp").hidden, ccVis: getComputedStyle(cc).visibility,
            core: k ? k.S.concept : null, cx: k ? k.S.c[0] / k.S.dpr : null, cy: k ? k.S.cssH - k.S.c[1] / k.S.dpr : null, R: k ? k.S.R / k.S.dpr : null,
            ccStill: !!(window.__joyaCC.core && window.__joyaCC.core.S && window.__joyaCC.core.S.still), kids: document.querySelectorAll(".dk-comp-kid").length };
        });
        check("the bot alone: its own core E at the top centre of the small window, the Command Center's pieces resting", st.mode === "companion" && st.out && st.comp && st.ccVis === "hidden" && st.core === "E" && Math.abs(st.cx - 88) < 1 && Math.abs(st.cy - C.BODY_CY) < 1 && Math.abs(st.R - C.HEAD_R) < 1 && st.ccStill && st.kids === 0, JSON.stringify(st));
        let regs = await lastRegs();
        check("  only the bot catches the mouse: one circle", regs && regs.length === 1 && regs[0].w === 2 * C.BODY_R && regs[0].r === C.BODY_R, JSON.stringify(regs));
        // its states, as the Command Center's
        const states = await page.evaluate(() => {
          const cc = document.getElementById("cc"), cp = window.JoyaDesktop.companion(), out = {};
          for (const s of ["listening", "thinking", "speaking", "needs", "idle"]) { cc.setAttribute("data-state", s); cp.debug.tick(); out[s] = cp.debug.core().S.state; }
          return out;
        });
        check("  its states follow the Command Center's: listening, thinking, speaking, needs you, ready", states.listening === "listening" && states.thinking === "thinking" && states.speaking === "speaking" && states.needs === "needs" && states.idle === "idle", JSON.stringify(states));
        // the face style (2026-10-22): the viewer's (#cc data-bot-face), switched live -- in this page or from Settings elsewhere
        const faces = await page.evaluate(() => {
          const k = () => window.JoyaDesktop.companion().debug.core(), out = { first: k().S.face };
          window.JoyaBot.setFace("dots"); out.set = k().S.face + "/" + document.getElementById("cc").getAttribute("data-bot-face");
          window.dispatchEvent(new StorageEvent("storage", { key: "joya-bot", newValue: JSON.stringify({ face: "minimal" }) })); out.storage = k().S.face;
          window.JoyaBot.setFace("smooth"); out.back = k().S.face;
          return out;
        });
        check("  its face is the viewer's (smooth by default) and switches live: in the page (JoyaBot.setFace) and from Settings in the app (storage note)", faces.first === "smooth" && faces.set === "dots/dots" && faces.storage === "minimal" && faces.back === "smooth", JSON.stringify(faces));
        // hovering: the hint
        await page.hover("#dk-comp-hit");
        await sleep(300);
        const hint = await page.evaluate(() => { const h = document.getElementById("dk-comp-hint"), b = h.getBoundingClientRect(); return { op: getComputedStyle(h).opacity, top: b.top, inside: b.left >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight }; });
        check("  hovering it: \"Click to open\" under the bot, inside the window", hint.op === "1" && hint.top >= C.BODY_CY + C.BODY_R && hint.inside, JSON.stringify(hint));
        await page.mouse.move(2, 158);
        // the living canvas rests; the "Camera on" pill sits under the bot and catches the mouse
        const cv = await page.evaluate(async () => {
          const cc = document.getElementById("cc");
          const r = { has: !!window.JoyaCanvas, loaded: !!(window.JoyaCanvas && window.JoyaCanvas.state.loaded) };
          cc.removeAttribute("data-cv-mode");
          if (window.JoyaCanvas) window.JoyaCanvas.refresh();
          await new Promise((res) => setTimeout(res, 1300));
          r.drew = cc.hasAttribute("data-cv-mode");
          const pill = document.createElement("div");
          pill.className = "mp-cam"; pill.id = "mp-cam";
          pill.innerHTML = '<span class="mp-dot"></span><span class="mp-t">Camera on · eye contact</span><button type="button" class="mp-off">Off</button>';
          document.body.appendChild(pill);
          await new Promise((res) => setTimeout(res, 300));
          const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions);
          const last = regs[regs.length - 1] || [];
          const pb = pill.getBoundingClientRect(), b = pill.querySelector(".mp-off").getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
          r.pillVis = getComputedStyle(pill).visibility; r.offShown = b.width > 0;
          r.under = pb.top > 62 + 40 && Math.abs((pb.left + pb.right) / 2 - window.innerWidth / 2) < 2 && pb.bottom <= window.innerHeight && pb.left >= 0 && pb.right <= window.innerWidth;
          r.offHit = last.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
          r.n = last.length;
          return r;
        });
        check("  the living canvas rests while the bot is out: nothing is drawn", cv.has && cv.loaded && !cv.drew, JSON.stringify(cv));
        check("  eye contact's \"Camera on\" pill: visible, centred under the bot inside the window, its Off button a hit region", cv.pillVis === "visible" && cv.offShown && cv.under && cv.offHit && cv.n === 2, JSON.stringify(cv));
        // moving to another monitor: a quick fade out, then in
        await page.evaluate(() => window.__emit("joya://companion", { kind: "fade-out" }));
        await sleep(400);
        const fo = await page.evaluate(() => ({ faded: document.documentElement.classList.contains("dk-comp-faded"), op: getComputedStyle(document.getElementById("dk-comp")).opacity, pill: getComputedStyle(document.getElementById("mp-cam")).opacity }));
        regs = await lastRegs();
        check("fade-out (it moves to the other monitor): the bot and the pill fade away, nothing catches the mouse", fo.faded && fo.op === "0" && fo.pill === "0" && regs && regs.length === 0, JSON.stringify([fo, regs]));
        await page.evaluate(() => window.__emit("joya://companion", { kind: "fade-in" }));
        await sleep(400);
        const fi = await page.evaluate(() => ({ faded: document.documentElement.classList.contains("dk-comp-faded"), op: getComputedStyle(document.getElementById("dk-comp")).opacity }));
        regs = await lastRegs();
        check("  fade-in (placed on the new monitor): back, the bot and the pill catch the mouse again", !fi.faded && fi.op === "1" && regs && regs.length === 2, JSON.stringify([fi, regs]));
        // full screen: duck, then pop
        await page.evaluate(() => window.__emit("joya://companion", { kind: "duck" }));
        await sleep(300);
        const dk = await page.evaluate(() => getComputedStyle(document.getElementById("dk-comp")).opacity);
        await page.evaluate(() => window.__emit("joya://companion", { kind: "pop" }));
        await sleep(300);
        const pp = await page.evaluate(() => getComputedStyle(document.getElementById("dk-comp")).opacity);
        check("full screen: it fades out (duck) and comes back after (pop)", dk === "0" && pp === "1", JSON.stringify([dk, pp]));
        await page.evaluate(() => document.getElementById("mp-cam").remove());
        // 0.1.12's events (an app not yet updated): ignored, nothing breaks
        await page.evaluate(() => { for (const k of ["walk", "hop", "out", "in", "jump", "arrive", "attention"]) window.__emit("joya://companion", { kind: k, ms: 500, dir: 1, view: { stance: "hang" } }); });
        await sleep(200);
        const lay = await page.evaluate(() => window.JoyaDesktop.companion().debug.layout());
        check("  0.1.12's walk / hop / arrive events are ignored: the bot stays put", lay.cx === 88 && lay.cy === C.BODY_CY, JSON.stringify(lay));
        // a click on the bot: its Peek
        await page.click("#dk-comp-hit");
        const clicked = await page.evaluate(() => window.__calls.some((c) => c[0] === "companion" && c[1].kind === "open"));
        check("a click on the bot asks the app to open its Command Center (companion: open)", clicked);
        await page.setViewportSize({ width: 1440, height: 860 });
        await page.evaluate(() => window.__emit("joya://state", { mode: "companion", peekOpen: true, companion: { stayOnMonitor: false, ducked: false } }));
        await page.waitForTimeout(400);
        const pk = await page.evaluate(() => { const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions); const r = regs[regs.length - 1]; return { mode: document.documentElement.getAttribute("data-dk-mode"), open: document.documentElement.classList.contains("dk-peek-open"), comp: document.getElementById("dk-comp").hidden, ccVis: getComputedStyle(document.getElementById("cc")).visibility, all: r && r.length === 1 && r[0].w === 1440 }; });
        check("  its Peek: laid out as Peek, the whole window catches the mouse, the bot's canvas away", pk.mode === "peek" && pk.open && pk.comp && pk.ccVis === "visible" && pk.all, JSON.stringify(pk));
        await page.waitForTimeout(1300);
        check("  the living canvas draws again once the Command Center is open", await page.evaluate(() => document.getElementById("cc").hasAttribute("data-cv-mode")));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        check("  Esc asks the app to close it (hide_peek)", await page.evaluate(() => window.__calls.some((c) => c[0] === "hide_peek")));
        await page.setViewportSize({ width: 176, height: 160 });
        await page.evaluate(() => window.__emit("joya://state", { mode: "companion", peekOpen: false, companion: { stayOnMonitor: false, ducked: false } }));
        await page.waitForTimeout(400);
        const back = await page.evaluate(() => ({ out: document.documentElement.classList.contains("dk-comp-out"), faded: document.documentElement.classList.contains("dk-comp-faded"), L: window.JoyaDesktop.companion().debug.layout() }));
        regs = await lastRegs();
        check("  closed: back out at the top, one circle", back.out && !back.faded && back.L.cx === 88 && regs && regs.length === 1, JSON.stringify([back, regs]));
        const csp = await page.evaluate(() => window.__csp);
        check("no page errors, no CSP violations", errs.length === 0 && csp.length === 0, JSON.stringify(errs.concat(csp)));
        await ctx.close();
        // holding still (battery saver, energy saver, full screen): one still frame, no loop, no fade transition
        const b = await open(Object.assign({}, HOST, { still: true }));
        const still = await b.page.evaluate(async () => { await new Promise((r) => setTimeout(r, 600)); const k = window.JoyaDesktop.companion().debug.core(); return { still: k.S.still, running: k.S.running, tr: getComputedStyle(document.getElementById("dk-comp")).transitionDuration }; });
        check("holding still: the bot draws one still frame, does not run its loop, and does not animate the fade", still.still === true && still.running === false && /^0s/.test(still.tr), JSON.stringify(still));
        check("  no page errors", b.errs.length === 0, JSON.stringify(b.errs));
        await b.ctx.close();
        // the page in 0.1.12's window (the dashboard deploys before the app updates)
        const o = await open({ mode: "companion", peekOpen: false, still: false, companion: { perch: "both", sessionBots: true, stance: "stand", lean: 0, openSide: "left", ducked: false } }, 264, 140);
        const ol = await o.page.evaluate(() => { const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions); return { L: window.JoyaDesktop.companion().debug.layout(), r: regs[regs.length - 1] }; });
        check("an app still on 0.1.12 (its 264 x 140 window and view): the bot at the top centre, one circle inside the window, no errors", ol.L.cx === 132 && ol.r && ol.r.length === 1 && ol.r[0].y + ol.r[0].h <= 140 && o.errs.length === 0, JSON.stringify(ol));
        await o.ctx.close();
        // another mode: the companion stays away
        const f = await open({ mode: "floating", peekOpen: false }, 480, 860);
        const fl = await f.page.evaluate(() => ({ comp: document.getElementById("dk-comp").hidden, out: document.documentElement.classList.contains("dk-comp-out") }));
        check("Floating: no companion bot", fl.comp && !fl.out, JSON.stringify(fl));
        await f.ctx.close();
      } finally {
        if (browser) await browser.close();
        s.stop();
      }
    }
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
